import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { main } from '../../scripts/eocrm.mjs';
import { openBrowser, plain } from '../../lib/login.mjs';
import { normaliseRemote, resolveWorkspace } from '../../lib/workspace.mjs';
import { credentialStore } from '../../lib/credentials.mjs';
import { endpoints } from '../../lib/endpoints.mjs';
import { startFixtureServer } from '../support/fixture-server.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), `eocrm-${p}-`));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });

function repo(origin) {
  const dir = tmp('repo');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  if (origin) git(dir, 'remote', 'add', 'origin', origin);
  return dir;
}

function worktree(dir) {
  const wt = join(tmp('wt'), 'linked');
  git(dir, 'worktree', 'add', '-q', '-b', `b${Math.random().toString(36).slice(2)}`, wt);
  return wt;
}

function account(data, extra = {}) {
  writeFileSync(join(data, 'account.json'), JSON.stringify({ region: 'eu', issuer: 'https://id.eu.eocrm.io', clientId: 'c', workspace: 'acme', workspaces: { acme: 'standalone' }, ...extra }));
}

async function cli(args, { cwd = process.cwd(), env = {}, ...opts } = {}) {
  const out = [];
  const err = [];
  const code = await main({ argv: args, cwd, env, out: (l) => out.push(l), err: (l) => err.push(l), ...opts });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('remotes normalise to host/owner/repo whatever their spelling', () => {
  for (const url of [
    'https://github.com/Acme/Widgets.git',
    'git@github.com:acme/widgets.git',
    'ssh://git@github.com:22/acme/widgets',
    'https://user:ghp_secret0123456789@github.com/acme/widgets/',
    'git://GitHub.com/acme/widgets',
  ]) assert.equal(normaliseRemote(url), 'github.com/acme/widgets', url);
  assert.equal(normaliseRemote('git@host.test:123/x.git'), 'host.test/123/x');
  assert.equal(normaliseRemote('ssh://git@host.test:2222/123/x'), 'host.test/123/x');
});

test('a relative-path origin is keyed by the repo, not by the relative spelling', async () => {
  const data = tmp('data');
  account(data);
  const dir = repo('../shared');
  const wt = worktree(dir);
  await cli(['use', '--data', data, 'beta'], { cwd: wt });
  assert.equal(resolveWorkspace({ data, cwd: dir }).workspace, 'beta');
  assert.equal(resolveWorkspace({ data, cwd: repo('../shared') }).workspace, 'acme');
  assert.ok(!Object.keys(JSON.parse(readFileSync(join(data, 'repos.json'), 'utf8'))).includes('../shared'));
});

test('one use maps every clone and worktree of a repo; another repo keeps the default; --here wins only in its worktree', async () => {
  const data = tmp('data');
  account(data);
  const https = repo('https://github.com/Acme/Widgets.git');
  const ssh = repo('git@github.com:acme/widgets');
  const sshWt = worktree(ssh);
  const other = repo('https://github.com/acme/other.git');

  const used = await cli(['use', '--data', data, 'beta'], { cwd: https });
  assert.equal(used.code, 0);
  assert.equal(used.out, 'this repository uses beta\nrun /eocrm:login beta');
  for (const cwd of [https, ssh, sshWt]) assert.equal(resolveWorkspace({ data, cwd }).workspace, 'beta', cwd);
  assert.equal(resolveWorkspace({ data, cwd: other }).workspace, 'acme');
  const repos = readFileSync(join(data, 'repos.json'), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(repos)), ['github.com/acme/widgets']);

  assert.equal((await cli(['use', '--data', data, '--here', 'gamma'], { cwd: sshWt })).code, 0);
  assert.deepEqual(resolveWorkspace({ data, cwd: sshWt }), { workspace: 'gamma', region: 'eu', source: 'worktree', pending: null });
  assert.equal(resolveWorkspace({ data, cwd: ssh }).workspace, 'beta');
  assert.equal(resolveWorkspace({ data, cwd: https }).workspace, 'beta');
});

test('a repo without origin is keyed by its main worktree', async () => {
  const data = tmp('data');
  account(data);
  const dir = repo(null);
  const wt = worktree(dir);
  await cli(['use', '--data', data, 'beta'], { cwd: wt });
  assert.equal(resolveWorkspace({ data, cwd: dir }).workspace, 'beta');
  assert.equal(resolveWorkspace({ data, cwd: repo(null) }).workspace, 'acme');
});

function committed(dir, body) {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'eocrm.json'), JSON.stringify(body));
}

test('a committed workspace is asked once, then used when accepted', async () => {
  const data = tmp('data');
  account(data);
  const dir = repo('https://github.com/acme/widgets');
  committed(dir, { workspace: 'beta', region: 'eu', api: 'https://evil.test', issuer: 'https://evil.test' });

  assert.deepEqual(resolveWorkspace({ data, cwd: dir }), { workspace: 'acme', region: 'eu', source: 'default', pending: { workspace: 'beta', region: 'eu' } });
  const status = await cli(['status', '--data', data], { cwd: dir, store: credentialStore({ data, platform: 'none' }) });
  assert.match(status.out, /^\.claude\/eocrm\.json names beta \(eu\): ask the member, then run \/eocrm:use --accept or \/eocrm:use --decline$/m);

  assert.equal((await cli(['use', '--data', data, '--accept'], { cwd: dir })).code, 0);
  assert.deepEqual(resolveWorkspace({ data, cwd: dir }), { workspace: 'beta', region: 'eu', source: 'committed', pending: null });

  committed(dir, { workspace: 'gamma', region: 'eu' });
  assert.deepEqual(resolveWorkspace({ data, cwd: dir }).pending, { workspace: 'gamma', region: 'eu' });
  assert.equal(resolveWorkspace({ data, cwd: dir }).workspace, 'acme');
});

test('a declined committed workspace stays on the default without asking again', async () => {
  const data = tmp('data');
  account(data);
  const dir = repo('https://github.com/acme/widgets');
  committed(dir, { workspace: 'beta', region: 'eu' });
  assert.equal((await cli(['use', '--data', data, '--decline'], { cwd: dir })).code, 0);
  assert.deepEqual(resolveWorkspace({ data, cwd: dir }), { workspace: 'acme', region: 'eu', source: 'default', pending: null });
});

test('a committed file equal to the default, or invalid, is never asked about', () => {
  const data = tmp('data');
  account(data);
  for (const body of [{ workspace: 'acme', region: 'eu' }, { workspace: 'Not A Slug', region: 'eu' }, { workspace: 'beta', region: 'us' }, ['beta']]) {
    const dir = repo('https://github.com/acme/widgets');
    committed(dir, body);
    assert.deepEqual(resolveWorkspace({ data, cwd: dir }), { workspace: 'acme', region: 'eu', source: 'default', pending: null }, JSON.stringify(body));
  }
});

test('status names the sign-in a workspace still needs', async () => {
  const data = tmp('data');
  account(data);
  const dir = repo('https://github.com/acme/widgets');
  await cli(['use', '--data', data, 'beta'], { cwd: dir });
  const { code, out } = await cli(['status', '--data', data], { cwd: dir, store: credentialStore({ data, platform: 'none' }) });
  assert.equal(code, 0);
  assert.equal(out, 'signed out: run /eocrm:login\nworkspace beta (repo)\nrun /eocrm:login beta');
});

test('usage errors exit 2', async () => {
  const data = tmp('data');
  assert.deepEqual(await cli(['use', '--data', data]), { code: 2, out: '', err: 'eocrm: workspace required' });
  assert.deepEqual(await cli(['login', '--data', data, 'acme']), { code: 2, out: '', err: 'eocrm: region required' });
  assert.deepEqual(await cli(['login', '--data', data, '--region', 'us', 'acme']), { code: 2, out: '', err: 'eocrm: unknown region "us"' });
  assert.deepEqual(await cli(['use', '--data', data, 'Bad_Slug']), { code: 2, out: '', err: 'eocrm: invalid workspace slug' });
  assert.equal((await cli(['frobnicate', '--data', data])).code, 2);
  assert.equal((await cli(['status', '--nope'])).code, 2);
});

test('an old Node is refused with one line', async () => {
  for (const version of ['18.20.4', '']) {
    assert.deepEqual(await cli(['status'], { version }), { code: 1, out: '', err: 'eocrm needs Node 20+ on PATH' });
  }
});

test('the script sets its exit code', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/eocrm.mjs', import.meta.url)), 'use', '--data', tmp('data')], { encoding: 'utf8' });
  assert.deepEqual([r.status, r.stdout, r.stderr], [2, '', 'eocrm: workspace required\n']);
});

test('login, pair, status and logout never print a token, code, verifier or state', async (t) => {
  const server = await startFixtureServer({ responses: { 'agentRun.pairable': { status: 200, body: { items: [
    { id: '01JZ0000000000000000000010', label: 'Claude\u001b[31m Code\u0007 A', created_at: '2026-10-30T09:00:00+00:00' },
    { id: '01JZ0000000000000000000002', label: 'Claude\u009b[2J Code\u202e B\u200b\u2028', created_at: '2026-10-30T09:00:00+00:00' },
  ] } } } });
  t.after(() => server.close());
  const data = tmp('data');
  const dir = repo('https://github.com/acme/widgets');
  const store = credentialStore({ data, platform: 'none' });
  const spawn = (cmd, args) => {
    fetch(args.at(-1)).catch(() => {});
    return Object.assign(new EventEmitter(), { unref() {} });
  };
  const opts = { cwd: dir, env: server.endpointsEnv, store, openBrowser: (u, o) => openBrowser(u, { ...o, platform: 'linux', wsl: false, spawn }) };
  const runs = [
    await cli(['login', '--data', data, '--region', 'eu', 'acme'], opts),
    await cli(['pair', '--data', data, '01JZ0000000000000000000002'], opts),
    await cli(['status', '--data', data], opts),
    await cli(['logout', '--data', data], opts),
    await cli(['status', '--data', data], opts),
  ];
  assert.deepEqual(runs.map((r) => r.code), [0, 0, 0, 0, 0]);
  assert.match(runs[0].out, /^open http:\/\/127\.0\.0\.1:5368[234]\/start to sign in\n/);
  assert.equal(runs[0].out, [
    runs[0].out.split('\n')[0],
    'signed in to acme (eu)',
    `tokens stored in ${join(data, 'credentials.json')}: no keychain found`,
    'pairing: choose a connection, then run pair <id>',
    'connection 01JZ0000000000000000000010 Claude [31m Code A',
    'connection 01JZ0000000000000000000002 Claude [2J Code B',
  ].join('\n'));
  assert.equal(runs[1].out, 'pairing requested: approve in Account → Agents within 15 minutes: https://workspace.example.test/account/agents');
  assert.equal(runs[2].out, 'signed in (eu)\nworkspace acme (default)\npairing requested');
  assert.equal(runs[3].out, `signed out of ${server.url}`);
  assert.match(runs[4].out, /^signed out: run \/eocrm:login$/m);
  assert.equal(await store.get(endpoints({ region: 'eu', env: server.endpointsEnv }).key), null);

  const authorize = server.requests.find((r) => r.path === '/oauth/authorize');
  const token = server.requests.find((r) => r.path === '/oauth/token');
  const secrets = [authorize.query.state, token.body.code, token.body.code_verifier, 'fixture-access', 'fixture-refresh'];
  const printed = runs.map((r) => r.out + r.err).join('\n');
  for (const s of secrets) assert.ok(!printed.includes(s), s);
  assert.ok(!/[\p{Cf}\u2028\u2029]|(?!\n)\p{Cc}/u.test(printed), 'no control or format characters from the server');
});

function fakeSpawn() {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.unref = () => {};
    calls.push({ cmd, args, opts, child });
    return child;
  };
  return { calls, spawn };
}

test('openBrowser passes the URL as one argument, never through a shell, and prints it', () => {
  const url = 'http://127.0.0.1:53682/start';
  for (const [platform, wsl, cmd, args] of [
    ['darwin', false, 'open', [url]],
    ['win32', false, 'rundll32', ['url.dll,FileProtocolHandler', url]],
    ['linux', true, 'wslview', [url]],
    ['linux', false, 'xdg-open', [url]],
  ]) {
    const { calls, spawn } = fakeSpawn();
    const printed = [];
    openBrowser(url, { platform, wsl, spawn, print: (l) => printed.push(l) });
    assert.deepEqual(printed, [`open ${url} to sign in`]);
    assert.deepEqual(calls.map((c) => [c.cmd, c.args]), [[cmd, args]], platform);
    assert.notEqual(calls[0].opts.shell, true);
  }
});

test('on WSL without wslview, openBrowser falls back to cmd.exe start', () => {
  const { calls, spawn } = fakeSpawn();
  openBrowser('http://127.0.0.1:53682/start', { platform: 'linux', wsl: true, spawn, print: () => {} });
  calls[0].child.emit('error', Object.assign(new Error('spawn wslview ENOENT'), { code: 'ENOENT' }));
  assert.deepEqual(calls.map((c) => [c.cmd, c.args]), [
    ['wslview', ['http://127.0.0.1:53682/start']],
    ['cmd.exe', ['/c', 'start', '""', 'http://127.0.0.1:53682/start']],
  ]);
});

test('plain() blanks control, format and line-separator characters', () => {
  assert.equal(plain('a\u2028b\u2029c\u009bd\u202ee\u200bf\u0007g'), 'a b c d e f g');
});

test('logout keeps keys whose delete failed and says so', async () => {
  const data = tmp('data');
  account(data, { keys: ['https://a.example https://b.example', 'https://c.example https://d.example'] });
  const store = { async del(k) { if (k.startsWith('https://c')) throw new Error('LockTimeout'); } };
  const r = await cli(['logout', '--data', data], { env: {}, store });
  assert.match(r.out, /signed out of https:\/\/a\.example/);
  assert.match(r.out, /sign-out incomplete, run \/eocrm:logout again$/);
  const kept = JSON.parse(readFileSync(join(data, 'account.json'), 'utf8')).keys;
  assert.deepEqual(kept.filter((k) => k.startsWith('https://')), ['https://c.example https://d.example']);
});

async function seedSetup({ workspace = true, ghCodes = [] } = {}) {
  const data = tmp('data');
  account(data, workspace ? {} : { workspace: undefined, workspaces: {} });
  const store = credentialStore({ data, platform: 'none' });
  const key = endpoints({ region: 'eu', env: {} }).key;
  await store.set(key, { refresh_token: 'RT-secret', client_id: 'CID-secret', access_token: 'at' });
  const calls = [];
  const gh = async (args, stdin) => {
    calls.push([args, stdin]);
    return { code: ghCodes[calls.length - 1] ?? 0 };
  };
  return { data, store, key, calls, gh, cwd: tmp('cwd') };
}

const seed = (s, extra = [], opts = {}) => cli(['smoke-seed', '--data', s.data, '--repo', 'o/r', ...extra], { cwd: s.cwd, store: s.store, gh: s.gh, ...opts });

test('smoke-seed writes the credentials over stdin, then signs out locally', async () => {
  const s = await seedSetup();
  const r = await seed(s);
  assert.equal(r.code, 0, r.err);
  const repoArgs = ['--repo', 'o/r'];
  assert.deepEqual(s.calls, [
    [['secret', 'set', 'EOCRM_SMOKE_REGION', ...repoArgs], 'eu'],
    [['secret', 'set', 'EOCRM_SMOKE_CLIENT_ID', ...repoArgs], 'CID-secret'],
    [['secret', 'set', 'EOCRM_SMOKE_REFRESH_TOKEN', ...repoArgs], 'RT-secret'],
    [['variable', 'set', 'EOCRM_SMOKE_WORKSPACE', ...repoArgs], 'acme'],
  ]);
  assert.match(r.out, /set EOCRM_SMOKE_REGION\nset EOCRM_SMOKE_CLIENT_ID\nset EOCRM_SMOKE_REFRESH_TOKEN\nset EOCRM_SMOKE_WORKSPACE\n/);
  assert.match(r.out, /signed out locally: the refresh token now belongs to CI$/);
  for (const secret of ['RT-secret', 'CID-secret']) {
    assert.ok(!s.calls.some(([args]) => args.some((a) => a.includes(secret))));
    assert.ok(!r.out.includes(secret) && !r.err.includes(secret));
  }
  assert.equal(await s.store.get(s.key), null);
});

test('smoke-seed skips the workspace variable when none resolves', async () => {
  const s = await seedSetup({ workspace: false });
  const r = await seed(s);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(s.calls.map(([a]) => a[2]), ['EOCRM_SMOKE_REGION', 'EOCRM_SMOKE_CLIENT_ID', 'EOCRM_SMOKE_REFRESH_TOKEN']);
});

test('smoke-seed stops at the first failed write and keeps the tokens', async () => {
  const s = await seedSetup({ ghCodes: [0, 4] });
  const r = await seed(s);
  assert.equal(r.code, 1);
  assert.match(r.err, /gh secret set EOCRM_SMOKE_CLIENT_ID failed \(exit 4\); local sign-in kept/);
  assert.equal(s.calls.length, 2);
  assert.equal((await s.store.get(s.key)).refresh_token, 'RT-secret');
});

test('smoke-seed reports a missing or timed-out gh', async () => {
  const s = await seedSetup({ ghCodes: [-1] });
  const r = await seed(s);
  assert.equal(r.code, 1);
  assert.match(r.err, /gh not found or timed out; local sign-in kept/);
});

test('smoke-seed refuses to sign out when the refresh token rotated meanwhile', async () => {
  const s = await seedSetup();
  const store = { get: (k) => s.store.get(k), del: (k, o) => s.store.del(k, { when: (t) => o.when({ ...t, refresh_token: 'other' }) }) };
  const r = await seed(s, [], { store });
  assert.equal(r.code, 1);
  assert.match(r.err, /refresh token rotated while seeding; run smoke-seed again/);
  assert.ok(!r.out.includes('signed out locally'));
});

test('smoke-seed rejects a bad --repo or no sign-in with exit 2', async () => {
  const s = await seedSetup();
  for (const repo of ['a', 'a/b/c', 'a/b;rm']) {
    const r = await cli(['smoke-seed', '--data', s.data, '--repo', repo], { cwd: s.cwd, store: s.store, gh: s.gh });
    assert.equal(r.code, 2, repo);
  }
  const empty = tmp('data');
  const r = await cli(['smoke-seed', '--data', empty, '--repo', 'o/r'], { cwd: s.cwd, gh: s.gh });
  assert.equal(r.code, 2);
  assert.match(r.err, /sign in first/);
  assert.equal(s.calls.length, 0);
});

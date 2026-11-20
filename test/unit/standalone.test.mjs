import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { deviceSignIn, clientName, LoginError, CLI_CLIENT_ID } from '../../lib/login.mjs';
import { userAgent, VERSION } from '../../lib/api.mjs';
import { cliData, cliHarness } from '../../lib/paths.mjs';
import { credentialStore } from '../../lib/credentials.mjs';
import { main } from '../../scripts/eocrm.mjs';

const ISSUER = 'https://id.eu.eocrm.io';
const GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const ISSUED = { device_code: 'dc', user_code: 'BCDFGHJK', verification_uri: `${ISSUER}/oauth/device`, verification_uri_complete: `${ISSUER}/oauth/device?user_code=BCDFGHJK`, expires_in: 600, interval: 5 };
const TOKENS = { access_token: 'at', refresh_token: 'rt', expires_in: 3600 };

// routes: { 'GET /path': [[status, body], ...] }, the last answer repeats.
function mockFetch(t, routes) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? 'GET'} ${u.pathname}`;
    const body = typeof init.body === 'string' ? (init.headers['content-type'].includes('json') ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body))) : undefined;
    calls.push({ key, url: u.href, body, ua: init.headers['user-agent'] });
    const queue = routes[key] ?? [[404, {}]];
    const [status, json] = queue.length > 1 ? queue.shift() : queue[0];
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  });
  return calls;
}

const device = (t, polls, metadata = [[404, {}]]) => {
  const calls = mockFetch(t, { 'GET /.well-known/oauth-authorization-server': metadata, 'POST /oauth/device/code': [[200, ISSUED]], 'POST /oauth/token': polls });
  const sleeps = [];
  const printed = [];
  const run = () => deviceSignIn({ issuer: ISSUER, harness: 'cli', print: (l) => printed.push(l), sleep: async (ms) => { sleeps.push(ms); } });
  return { calls, sleeps, printed, run };
};

test('device sign-in waits out authorization_pending, adds 5 s per slow_down and stores the CLI client', async (t) => {
  const { calls, sleeps, printed, run } = device(t, [[400, { error: 'authorization_pending' }], [400, { error: 'slow_down' }], [400, { error: 'authorization_pending' }], [200, TOKENS]]);
  const tokens = await run();
  assert.equal(tokens.access_token, 'at');
  assert.equal(tokens.refresh_token, 'rt');
  assert.equal(tokens.client_id, CLI_CLIENT_ID);
  assert.ok(tokens.expires_at > Date.now() / 1000);
  assert.deepEqual(sleeps, [5000, 5000, 10000, 10000]);
  const [start] = calls.filter((c) => c.key === 'POST /oauth/device/code');
  assert.deepEqual(start.body, { client_id: CLI_CLIENT_ID, scope: 'agent:runs' });
  const polls = calls.filter((c) => c.key === 'POST /oauth/token');
  assert.equal(polls.length, 4);
  for (const p of polls) assert.deepEqual(p.body, { grant_type: GRANT, device_code: 'dc', client_id: CLI_CLIENT_ID });
  for (const c of calls) assert.equal(c.ua, `eocrm-cli/${VERSION} (unknown)`);
  assert.ok(printed.some((l) => l.includes(ISSUED.verification_uri) && l.includes('BCDFGHJK')), printed.join('\n'));
  assert.ok(!printed.join('\n').includes('dc'), 'the device code never reaches the terminal');
});

test('a denial ends device sign-in, whether eocrm answers 401 or 400', async (t) => {
  for (const status of [401, 400]) {
    const { run } = device(t, [[400, { error: 'authorization_pending' }], [status, { error: 'access_denied' }]]);
    await assert.rejects(run(), (e) => e instanceof LoginError && /denied/.test(e.message));
  }
});

test('an expired code ends device sign-in', async (t) => {
  const { run, calls } = device(t, [[400, { error: 'expired_token' }]]);
  await assert.rejects(run(), (e) => e instanceof LoginError && /expired/.test(e.message));
  assert.equal(calls.filter((c) => c.key === 'POST /oauth/token').length, 1);
});

test('device sign-in stops polling once expires_in has passed', async (t) => {
  mockFetch(t, { 'POST /oauth/device/code': [[200, { ...ISSUED, expires_in: 12 }]], 'POST /oauth/token': [[400, { error: 'authorization_pending' }]] });
  let clock = 0;
  const sleep = async (ms) => { clock += ms; };
  await assert.rejects(deviceSignIn({ issuer: ISSUER, harness: 'cli', print: () => {}, sleep, now: () => clock }), /expired/);
  assert.equal(globalThis.fetch.mock.calls.filter((c) => new URL(c.arguments[0]).pathname === '/oauth/token').length, 2);
});

test('the device endpoint comes from same-origin metadata, else <issuer>/oauth/device/code', async (t) => {
  const custom = `${ISSUER}/x/device`;
  const calls = mockFetch(t, { 'GET /.well-known/oauth-authorization-server': [[200, { device_authorization_endpoint: custom }]], 'POST /x/device': [[200, ISSUED]], 'POST /oauth/token': [[200, TOKENS]] });
  await deviceSignIn({ issuer: ISSUER, harness: 'cli', print: () => {}, sleep: async () => {} });
  assert.deepEqual(calls.map((c) => c.key), ['GET /.well-known/oauth-authorization-server', 'POST /x/device', 'POST /oauth/token']);

  const foreign = device(t, [[200, TOKENS]], [[200, { device_authorization_endpoint: 'https://evil.test/oauth/device/code' }]]);
  await foreign.run();
  assert.ok(foreign.calls.some((c) => c.url === `${ISSUER}/oauth/device/code`));
  assert.ok(!foreign.calls.some((c) => c.url.startsWith('https://evil.test')));
});

test('the package publishes the eocrm bin with everything it spawns', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, '@eocrm/cli');
  assert.equal(pkg.private, undefined);
  assert.deepEqual(pkg.bin, { eocrm: 'scripts/eocrm.mjs' });
  for (const f of ['scripts/eocrm.mjs', 'hooks/dispatch.mjs', 'lib/']) assert.ok(pkg.files.includes(f), f);
  assert.match(readFileSync(new URL('../../scripts/eocrm.mjs', import.meta.url), 'utf8'), /^#!\/usr\/bin\/env node\r?\n/);
});

test('the plugin keeps its client names and User-Agents; the CLI has its own', () => {
  assert.equal(clientName('claude'), 'Claude Code (eocrm plugin)');
  assert.equal(clientName(undefined), 'Claude Code (eocrm plugin)');
  assert.equal(clientName('codex'), 'Codex (eocrm plugin)');
  assert.equal(clientName('cli'), 'eocrm CLI');
  assert.equal(userAgent('claude'), `eocrm-plugin/${VERSION} (claude-code)`);
  assert.equal(userAgent(undefined), `eocrm-plugin/${VERSION} (claude-code)`);
  assert.equal(userAgent('codex'), `eocrm-plugin/${VERSION} (codex)`);
  assert.equal(userAgent('cli'), `eocrm-cli/${VERSION} (unknown)`);
  assert.equal(userAgent('cli', 'aider'), `eocrm-cli/${VERSION} (aider)`);
  assert.match(userAgent('cli'), /^eocrm-cli\/\d{1,9}\.\d{1,9}\.\d{1,9} \([a-z_-]+\)/);
});

test('the CLI data dir: XDG_DATA_HOME, then APPDATA on Windows, then ~/.local/share', () => {
  assert.equal(cliData({ XDG_DATA_HOME: '/x/data' }, 'linux', '/home/u'), posix.join('/x/data', 'eocrm'));
  assert.equal(cliData({}, 'linux', '/home/u'), '/home/u/.local/share/eocrm');
  assert.equal(cliData({ XDG_DATA_HOME: 'relative' }, 'linux', '/home/u'), '/home/u/.local/share/eocrm');
  assert.equal(cliData({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'darwin', '/Users/u'), '/Users/u/.local/share/eocrm');
  assert.equal(cliData({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u'), 'C:\\Users\\u\\AppData\\Roaming\\eocrm');
  assert.equal(cliData({}, 'win32', 'C:\\Users\\u'), win32.join('C:\\Users\\u', '.local', 'share', 'eocrm'));
  assert.equal(cliData({ XDG_DATA_HOME: 'D:\\xdg', APPDATA: 'C:\\a' }, 'win32', 'C:\\Users\\u'), 'D:\\xdg\\eocrm');
});

test('an npm install is the cli harness unless a flag says otherwise', () => {
  const npx = join(homedir(), '.npm', '_npx', 'abc', 'node_modules', '@eocrm', 'cli', 'scripts', 'eocrm.mjs');
  assert.equal(cliHarness({ env: {}, script: npx }), 'cli');
  assert.equal(cliHarness({ env: { CLAUDECODE: '1', CODEX_THREAD_ID: 't' }, script: npx }), 'cli');
  assert.equal(cliHarness({ flag: 'cli', env: {}, script: '/checkout/scripts/eocrm.mjs' }), 'cli');
  assert.equal(cliHarness({ flag: 'claude', env: {}, script: npx }), 'claude');
  assert.equal(cliHarness({ flag: 'codex', env: {}, script: npx }), 'codex');
  assert.equal(cliHarness({ env: {}, script: '/checkout/scripts/eocrm.mjs' }), 'claude');
});

test('the CLI keeps its keychain entry apart from the plugin\'s', async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push(args);
    return { code: 1, stdout: '' };
  };
  const data = mkdtempSync(join(tmpdir(), 'eocrm-kc-'));
  await credentialStore({ data, platform: 'linux', run }).get(ISSUER);
  await credentialStore({ data, platform: 'linux', run, service: 'eocrm-cli' }).get(ISSUER);
  assert.deepEqual(calls, [['lookup', 'service', 'eocrm-claude-plugin', 'account', ISSUER], ['lookup', 'service', 'eocrm-cli', 'account', ISSUER]]);
});

test('eocrm login --device from an npm install signs in to the XDG data dir as eocrm CLI', async (t) => {
  const base = 'http://127.0.0.1:9';
  const xdg = mkdtempSync(join(tmpdir(), 'eocrm-xdg-'));
  const env = { XDG_DATA_HOME: xdg, EOCRM_ENDPOINTS: JSON.stringify({ issuer: base, api: `${base}/{workspace}/api` }) };
  const calls = mockFetch(t, {
    'POST /oauth/device/code': [[200, { ...ISSUED, interval: 0.001 }]],
    'POST /oauth/token': [[200, TOKENS]],
    'GET /acme/api/v1/agent-work/conventions': [[200, {}]],
    'GET /acme/api/v1/agent-runs/pairable': [[200, { items: [] }]],
  });
  const out = [];
  const err = [];
  const script = join(tmpdir(), 'node_modules', '@eocrm', 'cli', 'scripts', 'eocrm.mjs');
  const data = join(xdg, 'eocrm');
  const store = credentialStore({ data: mkdtempSync(join(tmpdir(), 'eocrm-store-')), platform: 'none' });
  const code = await main({ argv: ['login', '--device', 'acme'], env, cwd: tmpdir(), out: (l) => out.push(l), err: (l) => err.push(l), script, store, openBrowser: () => assert.fail('no browser for --device') });
  assert.equal(code, 0, err.join('\n'));
  assert.ok(out.some((l) => l.includes('BCDFGHJK')), out.join('\n'));
  assert.ok(out.includes('signed in to acme (eu)'), out.join('\n'));
  assert.ok(existsSync(join(data, 'account.json')));
  assert.equal(JSON.parse(readFileSync(join(data, 'account.json'), 'utf8')).workspace, 'acme');
  assert.ok(!calls.some((c) => c.key === 'POST /oauth/register'));
  for (const c of calls) assert.match(c.ua, /^eocrm-cli\//);
});

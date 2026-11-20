import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync as runSync } from 'node:child_process';
import { AGENTS, agentOf, detectAgent } from '../../lib/cli/attribute.mjs';
import { hookLine, install, installCopy, installed, uninstall, launcherOf, launcherTarget } from '../../lib/cli/hooks.mjs';
import { HOOK_MS, IDLE_MS, runHook, sessionOf, startRun, stopRuns, sync } from '../../lib/cli/run.mjs';
import { prStatus } from '../../lib/git.mjs';
import { handle, runClient } from '../../lib/run.mjs';
import { outdatedNotice } from '../../lib/flush.mjs';
import { readOutbox } from '../../lib/outbox.mjs';
import { GitDeadline, LIVE_MS, LockTimeout, git as stateGit, gitTimeout, liveDirOf, liveSession, loadRun, loadWorktree, saveRun, worktreeOf } from '../../lib/state.mjs';
import { updateClone, updateRepo } from '../../lib/workspace.mjs';
import { VERSION } from '../../lib/api.mjs';
import { main } from '../../scripts/eocrm.mjs';

const tmp = (p) => realpathSync.native(mkdtempSync(join(tmpdir(), `eocrm-${p}-`)));
const ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', PATH: process.env.PATH, HOME: tmpdir() };
// Git for Windows' sh gets forward slashes (hooks.mjs shq).
const shPath = (p) => (process.platform === 'win32' ? p.replace(/\\/g, '/') : p);
const git = (cwd, args, { env = {}, input } = {}) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...ENV, ...env }, input, encoding: 'utf8' });

function repo() {
  const dir = tmp('repo');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}

function cliData() {
  const data = tmp('data');
  writeFileSync(join(data, 'account.json'), JSON.stringify({ region: 'eu', workspace: 'acme', workspaces: { acme: 'standalone' } }));
  return data;
}

const ctxOf = (data, extra = {}) => ({ data, env: {}, harness: 'cli', now: Date.now, spawnSync: () => {}, spawnFlush: () => {}, store: { get: async () => null, update: async () => null }, clientFor: () => ({ conventions: async () => null, listEvents: async () => null }), prStatus: () => null, ...extra });
const initRepo = (data, dir, extra = {}) => {
  updateClone(data, dir, { initialized: true, hooks: ['post-commit', 'pre-push', 'post-checkout'] });
  if (Object.keys(extra).length) updateRepo(data, dir, extra);
};
const commitHook = async (ctx, dir) => {
  const result = await runHook(ctx, 'post-commit', dir);
  await sync(ctx, dir);
  return result;
};
const bytes = (f) => ({ text: readFileSync(f).toString('base64'), mode: statSync(f).mode });
const commitEvents = (data) => readOutbox(data).filter((e) => e.kind === 'event' && e.event.type === 'commit');

// A launcher that records how a hook called it.
function fakeLauncher() {
  const dir = tmp('launcher');
  const calls = join(dir, 'calls.log');
  const launcher = join(dir, 'eocrm.mjs');
  writeFileSync(launcher, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');\n`);
  return { launcher, calls, data: dir };
}

test('attribution: each tool\'s own signal names it, and a bare VS Code terminal names nothing', () => {
  const cases = [
    [{ commit: { author: 'Ada (aider)' } }, 'aider'],
    [{ commit: { committer: 'Ada (aider)' } }, 'aider'],
    [{ commit: { message: 'fix\n\nCo-authored-by: aider (gpt-5) <aider@aider.chat>\n' } }, 'aider'],
    [{ env: { CLINE_ACTIVE: 'true', TERM_PROGRAM: 'vscode', CURSOR_TRACE_ID: 'x' } }, 'cline'],
    [{ env: { ROO_ACTIVE: '1', TERM_PROGRAM: 'vscode' } }, 'roo'],
    [{ env: { OPENCODE: '1' } }, 'opencode'],
    [{ env: { OPENCODE_CLIENT: 'cli' } }, 'opencode'],
    [{ env: { CURSOR_AGENT: '1' } }, 'cursor'],
    [{ env: { CURSOR_EXTENSION_HOST_ROLE: 'agent-exec' } }, 'cursor'],
    [{ env: { CURSOR_TRACE_ID: 'abc', TERM_PROGRAM: 'vscode' } }, null],
    [{ env: { CLAUDE_CODE: '1' } }, 'claude_code'],
    [{ env: { CODEX_CI: '1' } }, 'codex'],
    [{ env: { CLAUDECODE: '1' } }, 'claude_code'],
    [{ env: { CODEX_THREAD_ID: 't' } }, 'codex'],
    [{ env: { TERM_PROGRAM: 'vscode' } }, null],
    [{ env: { OPENCODE: '0' }, commit: { author: 'aider fan', message: 'about aider' } }, null],
  ];
  for (const [input, want] of cases) assert.equal(detectAgent(input), want, JSON.stringify(input));
  for (const [, want] of cases) if (want) assert.ok(AGENTS.includes(want));
  assert.equal(agentOf({ env: { TERM_PROGRAM: 'vscode' }, commit: {}, setting: 'roo' }), 'roo');
  assert.equal(agentOf({ env: { CLINE_ACTIVE: '1' }, commit: {}, setting: 'roo' }), 'cline');
  assert.equal(agentOf({ env: {}, commit: {}, setting: 'gpt' }), null);
  assert.equal(agentOf({ env: { CURSOR_TRACE_ID: 'abc' }, commit: {} }), null);
});

test('a commit with no agent signal and no repo setting starts no run and queues nothing', async () => {
  const dir = repo();
  const data = cliData();
  initRepo(data, dir);
  assert.equal(await commitHook(ctxOf(data, { env: { TERM_PROGRAM: 'vscode', CURSOR_TRACE_ID: 'x' } }), dir), 'no agent');
  assert.deepEqual(readOutbox(data), []);
  assert.equal(existsSync(join(data, 'runs')), false);
  updateRepo(data, dir, { agent: 'cursor' });
  assert.equal(await commitHook(ctxOf(data), dir), 'queued');
  const [start] = readOutbox(data).filter((e) => e.kind === 'start');
  const run = loadRun(data, start.sessionId);
  assert.equal(run.start.agent_kind, 'cursor');
  assert.equal(commitEvents(data)[0].event.sha, git(dir, ['rev-parse', 'HEAD']).trim());
});

test('hooks never touch the network: they queue and leave the send to a detached process', async (t) => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('no network in a hook');
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  const dir = repo();
  const data = cliData();
  const spawned = [];
  initRepo(data, dir);
  const ctx = ctxOf(data, { env: { CURSOR_AGENT: '1' }, spawnSync: () => spawned.push('sync'), spawnFlush: () => spawned.push('flush') });
  assert.equal(await runHook(ctx, 'post-commit', dir), 'queued');
  assert.equal(await runHook(ctx, 'post-commit', dir), 'duplicate');
  assert.equal(await runHook(ctx, 'pre-push', dir), 'quiet');
  assert.equal(calls, 0);
  assert.deepEqual(spawned, ['sync']);
  assert.equal(existsSync(join(data, 'runs')), false);
  assert.deepEqual(readOutbox(data), []);
});

test('a repository where init never ran: the hook does nothing, even with an agent signal', async () => {
  const dir = repo();
  const data = cliData();
  updateRepo(data, dir, { agent: 'roo' });
  const spawned = [];
  assert.equal(await runHook(ctxOf(data, { env: { CLINE_ACTIVE: 'true' }, spawnSync: () => spawned.push('sync') }), 'post-commit', dir), 'not initialized');
  assert.deepEqual([spawned, existsSync(join(data, 'cli-queue'))], [[], false]);
});

test('the hook gives up after its time budget', async () => {
  const dir = repo();
  const data = cliData();
  initRepo(data, dir);
  mkdirSync(liveDirOf(dir), { recursive: true });
  writeFileSync(join(liveDirOf(dir), 'cc1'), String(Date.now()));
  mkdirSync(join(data, '.lock'));
  writeFileSync(join(data, '.lock', 'owner'), 'someone');
  const started = Date.now();
  assert.equal(await runHook(ctxOf(data, { hookMs: 100 }), 'post-commit', dir), 'timeout');
  assert.ok(Date.now() - started < 1000);
  assert.equal(await runHook(ctxOf(data, { hookMs: 0 }), 'post-commit', dir), 'timeout');
});

test('run identity: one session per worktree and agent, a new run when the agent changes, after idle or on another branch', async () => {
  const dir = repo();
  const data = cliData();
  initRepo(data, dir);
  const key = worktreeOf(dir).key;
  let now = 1_000_000;
  const ctx = (env) => ctxOf(data, { env, now: () => now });
  const commit = async (m, env) => {
    git(dir, ['commit', '-q', '--allow-empty', '-m', m]);
    await commitHook(ctx(env), dir);
  };
  await commit('one', { CURSOR_AGENT: '1' });
  const cursor = sessionOf(key, 'cursor');
  assert.equal(cursor, `cli-${key}-cursor`);
  assert.equal(loadRun(data, cursor).clientRunId, cursor);
  saveRun(data, cursor, { runId: 'r1' });
  now += 60_000;
  await commit('two', { CURSOR_AGENT: '1' });
  assert.equal(loadRun(data, cursor).generation, 0);
  now += IDLE_MS + 1;
  await commit('three', { CURSOR_AGENT: '1' });
  assert.equal(loadRun(data, cursor).clientRunId, `${cursor}.1`);
  assert.equal(readOutbox(data).find((e) => e.kind === 'finish' && e.sessionId === `${cursor}--w0`).endedAt, new Date(1_060_000 + IDLE_MS).toISOString());
  await commit('four', { CLINE_ACTIVE: 'true' });
  assert.equal(loadRun(data, cursor).ended, true);
  const cline = sessionOf(key, 'cline');
  assert.equal(loadRun(data, cline).start.agent_kind, 'cline');
  git(dir, ['checkout', '-q', '-b', 'other']);
  await sync(ctx({}), dir);
  assert.equal(loadRun(data, cline).ended, true);
});

test('sync ends a commit-bounded run idle past IDLE_MS; an explicit run stays', async () => {
  const dir = repo();
  const data = cliData();
  initRepo(data, dir);
  let now = 1_000_000;
  const ctx = ctxOf(data, { now: () => now });
  const key = worktreeOf(dir).key;
  await startRun(ctx, dir, 'aider');
  now += IDLE_MS - 1;
  await sync(ctx, dir);
  assert.equal(loadRun(data, sessionOf(key, 'aider')).ended, false);
  now += 2;
  await sync(ctx, dir);
  assert.equal(loadRun(data, sessionOf(key, 'aider')).ended, true);
  await startRun(ctx, dir, 'roo', { explicit: true });
  now += 10 * IDLE_MS;
  await sync(ctx, dir);
  assert.equal(loadRun(data, sessionOf(key, 'roo')).ended, false);
});

test('idle and branch-switch ends are stamped at the last commit plus IDLE_MS, never after now; run stop is not', async () => {
  const dir = repo();
  const data = cliData();
  initRepo(data, dir);
  let now = 1_000_000;
  const ctx = ctxOf(data, { now: () => now });
  const key = worktreeOf(dir).key;
  const finishOf = (agent) => readOutbox(data).find((e) => e.kind === 'finish' && e.sessionId === sessionOf(key, agent));
  await startRun(ctx, dir, 'aider');
  saveRun(data, sessionOf(key, 'aider'), { lastCommitAt: 1_500_000 });
  now = 1_500_000 + 5 * IDLE_MS;
  await sync(ctx, dir);
  assert.equal(finishOf('aider').endedAt, new Date(1_500_000 + IDLE_MS).toISOString());
  await startRun(ctx, dir, 'roo');
  now += 1000;
  git(dir, ['checkout', '-q', '-b', 'other']);
  await sync(ctx, dir);
  assert.equal(finishOf('roo').endedAt, new Date(now).toISOString());
  await startRun(ctx, dir, 'cline', { explicit: true });
  await stopRuns(ctx, dir);
  assert.equal(finishOf('cline').endedAt, undefined);
});

test('a hook input cannot stamp a run end: only the CLI sets endedAt', async () => {
  const dir = repo();
  const data = cliData();
  const ctx = { data, env: {}, now: Date.now, spawnFlush: () => {}, reconcile: async () => ({ enqueued: 0 }) };
  await handle('SessionStart', { session_id: 'se1', cwd: dir, source: 'startup' }, ctx);
  await handle('SessionEnd', { session_id: 'se1', cwd: dir, endedAt: '2020-01-01T00:00:00.000Z' }, ctx);
  const fin = readOutbox(data).find((e) => e.kind === 'finish' && e.sessionId === 'se1');
  assert.ok(fin);
  assert.equal(fin.endedAt, undefined);
});

test('a live Claude Code session in the worktree keeps the CLI quiet until the session ends', async () => {
  const dir = repo();
  const data = cliData();
  const plugin = cliData();
  initRepo(data, dir, { agent: 'cursor' });
  const pctx = { data: plugin, env: {}, harness: 'claude', now: Date.now, spawnFlush: () => {}, reconcile: async () => ({ enqueued: 0 }) };
  await handle('SessionStart', { session_id: 'cc1', cwd: dir, source: 'startup' }, pctx);
  assert.equal(liveSession(liveDirOf(dir), Date.now()), 'cc1');
  assert.equal(await commitHook(ctxOf(data), dir), 'quiet');
  assert.equal(await runHook(ctxOf(data), 'pre-push', dir), 'quiet');
  assert.deepEqual(readOutbox(data), []);
  const quietSha = git(dir, ['rev-parse', 'HEAD']).trim();
  assert.ok(loadWorktree(data, worktreeOf(dir).key).reportedCommits.includes(quietSha));
  await handle('SessionEnd', { session_id: 'cc1', cwd: dir }, pctx);
  assert.equal(liveSession(liveDirOf(dir), Date.now()), null);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'after']);
  assert.equal(await commitHook(ctxOf(data), dir), 'queued');
  assert.deepEqual(commitEvents(data).map((e) => e.event.sha), [git(dir, ['rev-parse', 'HEAD']).trim()]);
});

test('a live mark goes stale after LIVE_MS and is removed; the CLI never marks itself live', async () => {
  const dir = repo();
  const live = liveDirOf(dir);
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, 'old'), String(Date.now() - LIVE_MS - 1));
  assert.equal(liveSession(live, Date.now()), null);
  assert.deepEqual(readdirSync(live), []);
  const data = cliData();
  await startRun(ctxOf(data), dir, 'roo', { explicit: true });
  assert.deepEqual(readdirSync(live), []);
});

test('husky: init chains its hook and uninstall restores it byte for byte', () => {
  const dir = repo();
  mkdirSync(join(dir, '.husky', '_'), { recursive: true });
  writeFileSync(join(dir, '.husky', '_', 'h'), '#!/usr/bin/env sh\nn=$(basename "$0")\ns=$(dirname "$(dirname "$0")")/$n\n[ ! -f "$s" ] && exit 0\nsh -e "$s" "$@"\n');
  writeFileSync(join(dir, '.husky', '_', 'post-commit'), '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n', { mode: 0o755 });
  writeFileSync(join(dir, '.husky', 'post-commit'), 'echo husky >> husky.log\n');
  git(dir, ['config', 'core.hooksPath', '.husky/_']);
  const before = bytes(join(dir, '.husky', '_', 'post-commit'));
  const fake = fakeLauncher();
  const { dir: hooks, done } = install(dir, fake);
  assert.equal(hooks, join(dir, '.husky', '_'));
  assert.deepEqual(done, ['post-commit', 'pre-push', 'post-checkout']);
  install(dir, fake);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'x']);
  assert.equal(readFileSync(join(dir, 'husky.log'), 'utf8'), 'husky\n');
  assert.equal(readFileSync(fake.calls, 'utf8'), `hook post-commit --data ${shPath(fake.data)}\n`);
  uninstall(dir);
  assert.deepEqual(bytes(join(dir, '.husky', '_', 'post-commit')), before);
  assert.equal(existsSync(join(dir, '.husky', '_', 'pre-push')), false);
});

test('lefthook, core.hooksPath and hand-written hooks are chained and restored exactly; a non-shell hook is left alone', () => {
  const dir = repo();
  const hooks = join(dir, 'githooks');
  mkdirSync(hooks);
  git(dir, ['config', 'core.hooksPath', 'githooks']);
  const files = {
    'post-commit': '#!/bin/sh\r\n# LEFTHOOK\r\ncall_lefthook run "post-commit" "$@"\r\n',
    'pre-push': '#!/usr/bin/env bash\n# caf\xe9 in latin1\nexit 0',
    'post-checkout': '#!/usr/bin/env python3\nprint("hi")\n',
  };
  for (const [n, text] of Object.entries(files)) writeFileSync(join(hooks, n), Buffer.from(text, 'latin1'), { mode: 0o750 });
  const before = Object.fromEntries(Object.keys(files).map((n) => [n, bytes(join(hooks, n))]));
  const { done, skipped } = install(dir, fakeLauncher());
  assert.deepEqual([done, skipped], [['post-commit', 'pre-push'], ['post-checkout: not a shell script']]);
  const lines = readFileSync(join(hooks, 'post-commit'), 'utf8').split('\r\n');
  assert.equal(lines[0], '#!/bin/sh');
  assert.match(lines[1], /# eocrm-cli$/);
  uninstall(dir);
  for (const n of Object.keys(files)) assert.deepEqual(bytes(join(hooks, n)), before[n], n);
});

test('the hook passes pre-push refs to the chained hook and still runs it when the stable copy is gone', () => {
  const dir = repo();
  const remote = tmp('remote');
  git(remote, ['init', '-q', '--bare']);
  git(dir, ['remote', 'add', 'origin', remote]);
  const hook = join(dir, '.git', 'hooks', 'pre-push');
  writeFileSync(hook, '#!/bin/sh\ncat > "$(git rev-parse --git-dir)/refs.log"\n', { mode: 0o755 });
  install(dir, { launcher: join(tmp('gone'), 'eocrm.mjs'), data: tmp('d') });
  git(dir, ['push', '-q', 'origin', 'main']);
  assert.match(readFileSync(join(dir, '.git', 'refs.log'), 'utf8'), /^refs\/heads\/main [0-9a-f]{40} refs\/heads\/main /);
  const greedy = join(tmp('greedy'), 'eocrm.mjs');
  writeFileSync(greedy, "import { readFileSync } from 'node:fs';\nreadFileSync(0);\n");
  install(dir, { launcher: greedy, data: tmp('d') });
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'again']);
  git(dir, ['push', '-q', 'origin', 'main']);
  assert.match(readFileSync(join(dir, '.git', 'refs.log'), 'utf8'), /^refs\/heads\/main [0-9a-f]{40} refs\/heads\/main /);
});

test('on Windows the hook calls the absolute node and launcher in sh-safe quoting', () => {
  const line = hookLine('pre-push', { node: 'C:\\Program Files\\nodejs\\node.exe', launcher: "C:\\Users\\O'Neil\\AppData\\Roaming\\eocrm\\bin\\eocrm.mjs", data: 'C:\\Users\\O\'Neil\\AppData\\Roaming\\eocrm', platform: 'win32' });
  assert.ok(line.includes(`L='C:/Users/O'\\''Neil/AppData/Roaming/eocrm/bin/eocrm.mjs'`), line);
  assert.ok(line.includes(`N='C:/Program Files/nodejs/node.exe'; [ -x "$N" ] || N=node; "$N" "$L" hook pre-push --data 'C:/Users/O'\\''Neil/AppData/Roaming/eocrm' "$@" </dev/null`), line);
  assert.doesNotMatch(line.replaceAll("'\\''", ''), /\\/);
});

test('the stable copy: init installs a versioned copy and a launcher, and re-init upgrades and repoints it', () => {
  const data = tmp('data');
  const launcher = installCopy(data, { version: '9.9.8' });
  assert.equal(launcher, launcherOf(data));
  assert.ok(existsSync(join(data, 'bin', '9.9.8', 'lib', 'cli', 'run.mjs')));
  installCopy(data, { version: '9.9.9' });
  assert.deepEqual(readdirSync(join(data, 'bin')).sort(), ['9.9.9', 'eocrm.mjs']);
  mkdirSync(join(data, 'bin', '9.9.9.dead.tmp'));
  installCopy(data, { from: join(data, 'bin', '9.9.9'), version: '9.9.9' });
  assert.deepEqual(readdirSync(join(data, 'bin')).sort(), ['9.9.9', 'eocrm.mjs']);
  assert.equal(launcherTarget(data), '9.9.9');
  const out = execFileSync(process.execPath, [launcher, 'status', '--data', data], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpdir() } });
  assert.match(out, /signed out: run eocrm login/);
});

test('eocrm init then a real commit queues it through the stable copy; uninstall removes the hooks', async () => {
  const dir = repo();
  const xdg = tmp('xdg');
  const store = { get: async () => ({ access_token: 'at' }), where: async () => 'file' };
  const env = { XDG_DATA_HOME: xdg, HOME: tmpdir() };
  const data = join(xdg, 'eocrm');
  mkdirSync(data);
  writeFileSync(join(data, 'account.json'), JSON.stringify({ region: 'eu', workspace: 'acme', workspaces: { acme: 'standalone' } }));
  const out = [];
  const code = await main({ argv: ['init', '--agent', 'opencode'], cwd: dir, env, out: (l) => out.push(l), err: (l) => out.push(l), store, harness: 'cli' });
  assert.equal(code, 0, out.join('\n'));
  const started = Date.now();
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'tracked'], { env: { EOCRM_ENDPOINTS: JSON.stringify({ issuer: 'http://127.0.0.1:9', api: 'http://127.0.0.1:9/{workspace}/api' }) } });
  assert.ok(Date.now() - started < 5000);
  const sha = git(dir, ['rev-parse', 'HEAD']).trim();
  for (let i = 0; i < 100 && !readOutbox(data).some((e) => e.kind === 'event' && e.event.sha === sha); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(readOutbox(data).some((e) => e.kind === 'event' && e.event.sha === sha), JSON.stringify(readOutbox(data)));
  assert.equal(await main({ argv: ['uninstall'], cwd: dir, env, out: () => {}, err: () => {}, harness: 'cli' }), 0);
  assert.deepEqual(readdirSync(join(dir, '.git', 'hooks')).filter((n) => !n.endsWith('.sample')), []);
});

test('gh absent, signed out or closed leaves the branch only; open and merged PRs are reported', () => {
  const run = (out) => () => (out instanceof Error ? (() => { throw out; })() : out);
  const url = 'https://github.com/o/r/pull/7';
  assert.equal(prStatus('/w', run(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }))), null);
  assert.equal(prStatus('/w', run(Object.assign(new Error('gh auth login'), { status: 4 }))), null);
  assert.equal(prStatus('/w', run(JSON.stringify({ url, state: 'CLOSED', number: 7 }))), null);
  assert.deepEqual(prStatus('/w', run(JSON.stringify({ url, state: 'OPEN', number: 7 }))), { action: 'opened', url, number: 7 });
  assert.deepEqual(prStatus('/w', run(JSON.stringify({ url, state: 'MERGED', number: 7 }))), { action: 'merged', url, number: 7 });
});

test('sync queues the branch PR for each live CLI run', async () => {
  const dir = repo();
  const data = cliData();
  const ctx = ctxOf(data, { store: { get: async () => null, update: async () => null }, clientFor: () => ({ conventions: async () => null, listEvents: async () => null }), prStatus: () => ({ action: 'opened', url: 'https://github.com/o/r/pull/3', number: 3 }) });
  await startRun(ctx, dir, 'aider', { explicit: true });
  const { runs } = await sync(ctx, dir);
  assert.equal(runs, 1);
  const pr = readOutbox(data).find((e) => e.kind === 'event' && e.event.type === 'pull_request');
  assert.deepEqual([pr.event.action, pr.event.repo, pr.event.number], ['opened', 'o/r', 3]);
});

test('the CLI sends its agent in the User-Agent; the outdated notice names the npx upgrade', async (t) => {
  const real = globalThis.fetch;
  const agents = [];
  globalThis.fetch = async (url, init) => {
    agents.push(init.headers['user-agent']);
    return new Response('{}', { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  const store = { get: async () => ({ access_token: 'at' }) };
  await runClient({ data: tmp('d'), env: {}, harness: 'cli', store })({ region: 'eu', workspace: 'acme', start: { agent_kind: 'roo' } }).conventions();
  assert.deepEqual(agents, [`eocrm-cli/${VERSION} (roo)`]);
  assert.match(outdatedNotice('9.0.0', 'cli').text, /Run npx @eocrm\/cli@latest init\.$/);
  assert.match(outdatedNotice('9.0.0', 'claude').text, /Run \/plugin marketplace update eocrm \(Codex: codex plugin marketplace upgrade eocrm\)\.$/);
});

test('plugin: SessionStart marks the worktree live, SessionEnd clears it; nothing else in the session changes', async (t) => {
  const dir = repo();
  const plugin = cliData();
  const ctx = { data: plugin, env: {}, harness: 'codex', now: Date.now, spawnFlush: () => {}, reconcile: async () => ({ enqueued: 0 }) };
  await handle('SessionStart', { session_id: 'cx1', cwd: dir, source: 'startup' }, ctx);
  const live = liveDirOf(dir);
  assert.equal(live, join(dir, '.git', 'eocrm-live'));
  assert.deepEqual(readdirSync(live), ['cx1']);
  const run = loadRun(plugin, 'cx1');
  assert.equal(run.start.agent_kind, undefined);
  assert.deepEqual(readOutbox(plugin).map((e) => e.kind), ['start']);
  await handle('SessionEnd', { session_id: 'cx1', cwd: dir }, ctx);
  assert.deepEqual(readdirSync(live), []);
  chmodSync(live, 0o500);
  t.after(() => chmodSync(live, 0o700));
  await handle('SessionStart', { session_id: 'cx2', cwd: dir, source: 'startup' }, ctx);
  assert.equal(loadRun(plugin, 'cx2').ended, false);
});

test('a shared core.hooksPath (global config) is refused without --shared-hooks', async (t) => {
  const dir = repo();
  const shared = tmp('shared-hooks');
  const global = join(tmp('gitconfig'), 'config');
  writeFileSync(global, `[core]\n\thooksPath = ${shPath(shared)}\n`);
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = global;
  t.after(() => {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
  });
  const xdg = tmp('xdg');
  mkdirSync(join(xdg, 'eocrm'));
  writeFileSync(join(xdg, 'eocrm', 'account.json'), JSON.stringify({ region: 'eu', workspace: 'acme', workspaces: { acme: 'standalone' } }));
  const run = async (argv) => {
    const out = [];
    const code = await main({ argv, cwd: dir, env: { XDG_DATA_HOME: xdg }, out: (l) => out.push(l), err: (l) => out.push(l), store: { get: async () => ({ access_token: 'at' }) }, harness: 'cli' });
    return { code, out: out.join('\n') };
  };
  const refused = await run(['init']);
  assert.equal(refused.code, 2);
  assert.match(refused.out, /core\.hooksPath comes from your global git config.*--shared-hooks/);
  assert.deepEqual(readdirSync(shared), []);
  const ok = await run(['init', '--shared-hooks']);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /core\.hooksPath is shared \(global config\)/);
  assert.ok(readdirSync(shared).includes('post-commit'));
});

test('a hook file tracked in git is skipped: no local paths go into committed files', () => {
  const dir = repo();
  mkdirSync(join(dir, 'githooks'));
  writeFileSync(join(dir, 'githooks', 'post-commit'), '#!/bin/sh\necho team\n', { mode: 0o755 });
  git(dir, ['add', 'githooks/post-commit']);
  git(dir, ['commit', '-q', '-m', 'team hooks']);
  git(dir, ['config', 'core.hooksPath', 'githooks']);
  const { done, skipped } = install(dir, fakeLauncher());
  assert.deepEqual(done, ['pre-push', 'post-checkout']);
  assert.match(skipped[0], /^post-commit: tracked in git/);
  assert.equal(readFileSync(join(dir, 'githooks', 'post-commit'), 'utf8'), '#!/bin/sh\necho team\n');
});

test('an eocrm-created hook keeps what the user added: re-init and uninstall strip only eocrm lines', () => {
  const dir = repo();
  const fake = fakeLauncher();
  install(dir, fake);
  const file = join(dir, '.git', 'hooks', 'post-commit');
  writeFileSync(file, `${readFileSync(file, 'utf8')}echo mine\n`);
  install(dir, fake);
  const text = readFileSync(file, 'utf8');
  assert.equal(text.split('\n').filter((l) => l.endsWith('# eocrm-cli')).length, 2);
  assert.ok(text.endsWith('echo mine\n'));
  uninstall(dir);
  assert.equal(readFileSync(file, 'utf8'), '#!/bin/sh\necho mine\n');
  assert.equal(existsSync(join(dir, '.git', 'hooks', 'pre-push')), false);
});

test('binary and non-executable hooks are skipped and reported', () => {
  const dir = repo();
  const hooks = join(dir, '.git', 'hooks');
  writeFileSync(join(hooks, 'post-commit'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0]), { mode: 0o755 });
  writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  const { done, skipped } = install(dir, fakeLauncher());
  // Git for Windows has no exec bit and runs every hook file.
  const win = process.platform === 'win32';
  assert.deepEqual(done, win ? ['pre-push', 'post-checkout'] : ['post-checkout']);
  assert.deepEqual(skipped.map((s) => s.split(':')[0]), win ? ['post-commit'] : ['post-commit', 'pre-push']);
  assert.match(skipped[0], /not a script/);
  if (!win) assert.match(skipped[1], /not executable/);
});

test('lefthook: the command also goes into a git-ignored lefthook-local.yml, and uninstall restores it and the exclude file exactly', () => {
  const dir = repo();
  writeFileSync(join(dir, 'lefthook.yml'), 'pre-commit:\n  commands:\n    lint:\n      run: echo lint\n');
  const exclude = join(dir, '.git', 'info', 'exclude');
  const excludeBefore = bytes(exclude);
  const fake = fakeLauncher();
  const { lefthook } = install(dir, fake);
  assert.equal(lefthook, join(dir, 'lefthook-local.yml'));
  const local = readFileSync(lefthook, 'utf8');
  assert.match(local, /^# created by eocrm init # eocrm-cli\npost-commit: # eocrm-cli\n {2}commands: # eocrm-cli\n {4}eocrm: # eocrm-cli\n {6}run: '\( L=''/);
  assert.ok(local.includes(`hook post-checkout --data ''${shPath(fake.data)}'' {0} </dev/null`));
  assert.equal(git(dir, ['check-ignore', 'lefthook-local.yml']).trim(), 'lefthook-local.yml');
  assert.equal(git(dir, ['status', '--porcelain', '--', 'lefthook-local.yml']), '');
  rmHookLines(dir);
  assert.deepEqual(installed(dir), ['post-commit', 'pre-push', 'post-checkout']);
  install(dir, fake);
  uninstall(dir);
  assert.equal(existsSync(lefthook), false);
  assert.deepEqual(bytes(exclude), excludeBefore);
});

test('lefthook: an existing lefthook-local.yml keeps its bytes; one that already defines a hook is left alone', () => {
  const dir = repo();
  writeFileSync(join(dir, 'lefthook.yml'), 'pre-commit: {}\n');
  writeFileSync(join(dir, '.gitignore'), 'lefthook-local.yml\n');
  writeFileSync(join(dir, 'lefthook-local.yml'), 'pre-commit:\n  skip: true');
  const before = bytes(join(dir, 'lefthook-local.yml'));
  install(dir, fakeLauncher());
  assert.ok(readFileSync(join(dir, 'lefthook-local.yml'), 'utf8').endsWith('# eocrm-cli\npre-commit:\n  skip: true'));
  uninstall(dir);
  assert.deepEqual(bytes(join(dir, 'lefthook-local.yml')), before);
  writeFileSync(join(dir, 'lefthook-local.yml'), 'post-commit:\n  skip: true\n');
  const { skipped } = install(dir, fakeLauncher());
  assert.match(skipped.at(-1), /^lefthook-local: .*already defines post-commit/);
});

// Simulates a hook manager regenerating its hook files without the eocrm line.
function rmHookLines(dir) {
  for (const n of ['post-commit', 'pre-push', 'post-checkout']) {
    const f = join(dir, '.git', 'hooks', n);
    if (existsSync(f)) writeFileSync(f, readFileSync(f, 'utf8').split('\n').filter((l) => !l.includes('eocrm')).join('\n'));
  }
}

test('status, sync and run start warn when a hook manager dropped the eocrm hooks; status names a broken stable copy', async () => {
  const dir = repo();
  const xdg = tmp('xdg');
  const data = join(xdg, 'eocrm');
  mkdirSync(data);
  writeFileSync(join(data, 'account.json'), JSON.stringify({ region: 'eu', workspace: 'acme', workspaces: { acme: 'standalone' } }));
  const run = async (argv) => {
    const out = [];
    await main({ argv, cwd: dir, env: { XDG_DATA_HOME: xdg }, out: (l) => out.push(l), err: (l) => out.push(l), store: { get: async () => ({ access_token: 'at' }), update: async () => null }, spawnFlush: () => {}, harness: 'cli' });
    return out.join('\n');
  };
  await run(['init', '--agent', 'roo']);
  assert.doesNotMatch(await run(['status']), /missing/);
  rmHookLines(dir);
  const warning = /eocrm hooks missing from post-commit, pre-push, post-checkout .*run eocrm init again/;
  assert.match(await run(['status']), warning);
  assert.match(await run(['run', 'start']), warning);
  assert.match(await run(['sync']), warning);
  const version = launcherTarget(data);
  rmSync(join(data, 'bin', version), { recursive: true });
  assert.match(await run(['status']), /copy of the CLI is missing or broken: run npx @eocrm\/cli@latest init/);
});

test('post-checkout to another branch spawns the sync that ends the old branch\'s run and checks its PR', async () => {
  const dir = repo();
  const data = cliData();
  initRepo(data, dir);
  const spawned = [];
  const ctx = ctxOf(data, { spawnSync: () => spawned.push('sync') });
  assert.equal(await runHook(ctx, 'post-checkout', dir, ['a', 'b', '1']), 'quiet');
  await startRun(ctx, dir, 'aider');
  assert.equal(await runHook(ctx, 'post-checkout', dir, ['a', 'b', '0']), 'quiet');
  assert.equal(await runHook(ctx, 'post-checkout', dir, ['a', 'b', '1']), 'queued');
  assert.deepEqual(spawned, ['sync']);
});

test('the hook process exits within its budget: a held lock with a live mark, and a git that hangs', () => {
  const dir = repo();
  const data = cliData();
  initRepo(data, dir);
  mkdirSync(liveDirOf(dir), { recursive: true });
  writeFileSync(join(liveDirOf(dir), 'cc1'), String(Date.now()));
  mkdirSync(join(data, '.lock'));
  writeFileSync(join(data, '.lock', 'owner'), 'someone');
  const cli = join(process.cwd(), 'scripts', 'cli.mjs');
  const hook = (env) => {
    const started = Date.now();
    runSync(process.execPath, [cli, 'hook', 'post-commit', '--data', data], { cwd: dir, env: { ...ENV, ...env }, stdio: 'ignore' });
    return Date.now() - started;
  };
  assert.ok(hook({}) <= HOOK_MS + 1000);
  const bin = tmp('slow-git');
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nsleep 30 </dev/null >/dev/null 2>&1\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const slow = hook({ PATH: `${bin}:${process.env.PATH}` });
  assert.ok(slow <= HOOK_MS + 1000, `took ${slow} ms`);
});

test('a lock timeout mid-drain puts the unprocessed commits back in the queue', async () => {
  const dir = repo();
  const data = cliData();
  initRepo(data, dir);
  const ctx = ctxOf(data, { env: { CURSOR_AGENT: '1' } });
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'two']);
  const first = git(dir, ['rev-parse', 'HEAD']).trim();
  await runHook(ctx, 'post-commit', dir);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'three']);
  const second = git(dir, ['rev-parse', 'HEAD']).trim();
  await runHook(ctx, 'post-commit', dir);
  let calls = 0;
  await sync({ ...ctx, startRun: async (...args) => {
    if (++calls === 2) throw new LockTimeout(data);
    return startRun(...args);
  } }, dir);
  assert.deepEqual(commitEvents(data).map((e) => e.event.sha), [first]);
  await sync(ctx, dir);
  assert.deepEqual(commitEvents(data).map((e) => e.event.sha), [first, second]);
});

test('the init gate is per clone: uninstall in one clone leaves another tracking; a never-initialised clone of the same remote stays quiet', async () => {
  const remote = tmp('remote');
  git(remote, ['init', '-q', '--bare']);
  const clone = () => {
    const dir = repo();
    git(dir, ['remote', 'add', 'origin', `https://github.com/acme/widgets.git`]);
    return dir;
  };
  const [a, b, c] = [clone(), clone(), clone()];
  const xdg = tmp('xdg');
  const data = join(xdg, 'eocrm');
  mkdirSync(data);
  writeFileSync(join(data, 'account.json'), JSON.stringify({ region: 'eu', workspace: 'acme', workspaces: { acme: 'standalone' } }));
  const run = (argv, cwd) => main({ argv, cwd, env: { XDG_DATA_HOME: xdg }, out: () => {}, err: () => {}, store: { get: async () => ({ access_token: 'at' }) }, harness: 'cli' });
  assert.equal(await run(['init', '--agent', 'aider'], a), 0);
  assert.equal(await run(['init'], b), 0);
  assert.equal(await run(['uninstall'], a), 0);
  const ctx = ctxOf(data);
  assert.equal(await runHook(ctx, 'post-commit', a), 'not initialized');
  assert.equal(await runHook(ctx, 'post-commit', b), 'queued');
  assert.equal(await runHook(ctx, 'post-commit', c), 'not initialized');
});

test('info/exclude is restored byte for byte: no trailing newline, or a file eocrm created', () => {
  for (const before of ['mine.txt', null]) {
    const dir = repo();
    writeFileSync(join(dir, 'lefthook.yml'), 'pre-commit: {}\n');
    const exclude = join(dir, '.git', 'info', 'exclude');
    if (before === null) rmSync(exclude);
    else writeFileSync(exclude, before);
    install(dir, fakeLauncher());
    assert.equal(git(dir, ['check-ignore', 'lefthook-local.yml']).trim(), 'lefthook-local.yml');
    if (before) assert.equal(git(dir, ['check-ignore', 'mine.txt']).trim(), 'mine.txt');
    uninstall(dir);
    assert.equal(existsSync(exclude) ? readFileSync(exclude, 'utf8') : null, before);
  }
});

test('uninstall finds lefthook-local.yml after lefthook.yml is gone; linked worktrees keep a shared exclude entry until the last one uninstalls', () => {
  const dir = repo();
  writeFileSync(join(dir, 'lefthook.yml'), 'pre-commit: {}\n');
  git(dir, ['add', 'lefthook.yml']);
  git(dir, ['commit', '-q', '-m', 'lefthook']);
  const linked = join(tmp('wt'), 'linked');
  git(dir, ['worktree', 'add', '-q', '-b', 'side', linked]);
  const exclude = join(dir, '.git', 'info', 'exclude');
  const before = readFileSync(exclude, 'utf8');
  install(dir, fakeLauncher());
  install(linked, fakeLauncher());
  uninstall(linked);
  assert.equal(existsSync(join(linked, 'lefthook-local.yml')), false);
  assert.notEqual(readFileSync(exclude, 'utf8'), before);
  rmSync(join(dir, 'lefthook.yml'));
  uninstall(dir);
  assert.equal(existsSync(join(dir, 'lefthook-local.yml')), false);
  assert.equal(readFileSync(exclude, 'utf8'), before);
});

test('status sends the finish of runs it ended as idle', async () => {
  const dir = repo();
  const xdg = tmp('xdg');
  const data = join(xdg, 'eocrm');
  mkdirSync(data);
  writeFileSync(join(data, 'account.json'), JSON.stringify({ region: 'eu', workspace: 'acme', workspaces: { acme: 'standalone' } }));
  initRepo(data, dir);
  await startRun(ctxOf(data, { now: () => Date.now() - IDLE_MS - 1 }), dir, 'aider');
  const flushes = [];
  const out = [];
  await main({ argv: ['status'], cwd: dir, env: { XDG_DATA_HOME: xdg }, out: (l) => out.push(l), err: () => {}, store: { get: async () => ({ access_token: 'at' }) }, spawnFlush: () => flushes.push(1), harness: 'cli' });
  assert.match(out.join('\n'), /run aider ended: idle/);
  assert.equal(flushes.length, 1);
});

test('past the hook deadline git is not run at all', () => {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push(opts.timeout);
    return 'ok';
  };
  const saved = { ...gitTimeout };
  try {
    Object.assign(gitTimeout, { ms: 1000, deadline: Date.now() + 300 });
    assert.equal(stateGit('/w', ['status'], run), 'ok');
    Object.assign(gitTimeout, { deadline: Date.now() - 1 });
    assert.throws(() => stateGit('/w', ['status'], run), GitDeadline);
  } finally {
    Object.assign(gitTimeout, saved);
  }
  assert.equal(calls.length, 1);
  assert.ok(calls[0] <= 300);
});

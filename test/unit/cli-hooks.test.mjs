import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { AGENTS, agentOf, detectAgent } from '../../lib/cli/attribute.mjs';
import { hookLine, install, installCopy, uninstall, launcherOf } from '../../lib/cli/hooks.mjs';
import { IDLE_MS, runHook, sessionOf, startRun, sync } from '../../lib/cli/run.mjs';
import { prStatus } from '../../lib/git.mjs';
import { handle, runClient } from '../../lib/run.mjs';
import { outdatedNotice } from '../../lib/flush.mjs';
import { readOutbox } from '../../lib/outbox.mjs';
import { LIVE_MS, liveDirOf, liveSession, loadRun, loadWorktree, saveRun, worktreeOf } from '../../lib/state.mjs';
import { updateRepo } from '../../lib/workspace.mjs';
import { VERSION } from '../../lib/api.mjs';
import { main } from '../../scripts/eocrm.mjs';

const tmp = (p) => realpathSync.native(mkdtempSync(join(tmpdir(), `eocrm-${p}-`)));
const ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', PATH: process.env.PATH, HOME: tmpdir() };
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

const ctxOf = (data, extra = {}) => ({ data, env: {}, harness: 'cli', now: Date.now, spawnSync: () => {}, spawnFlush: () => {}, ...extra });
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
    [{ env: { CURSOR_TRACE_ID: 'abc' } }, 'cursor'],
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
});

test('a commit with no agent signal and no repo setting starts no run and queues nothing', async () => {
  const dir = repo();
  const data = cliData();
  assert.equal(await runHook(ctxOf(data, { env: { TERM_PROGRAM: 'vscode' } }), 'post-commit', dir), 'no agent');
  assert.deepEqual(readOutbox(data), []);
  assert.equal(existsSync(join(data, 'runs')), false);
  updateRepo(data, dir, { agent: 'cursor' });
  assert.equal(await runHook(ctxOf(data), 'post-commit', dir), 'queued');
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
  const ctx = ctxOf(data, { env: { CURSOR_AGENT: '1' }, spawnSync: () => spawned.push('sync'), spawnFlush: () => spawned.push('flush') });
  assert.equal(await runHook(ctx, 'post-commit', dir), 'queued');
  assert.equal(await runHook(ctx, 'pre-push', dir), 'queued');
  assert.equal(calls, 0);
  assert.deepEqual(spawned, ['sync', 'sync']);
});

test('run identity: one session per worktree and agent, a new run when the agent changes or after idle', async () => {
  const dir = repo();
  const data = cliData();
  const key = worktreeOf(dir).key;
  let now = 1_000_000;
  const ctx = (env) => ctxOf(data, { env, now: () => now });
  await runHook(ctx({ CURSOR_AGENT: '1' }), 'post-commit', dir);
  const cursor = sessionOf(key, 'cursor');
  assert.equal(cursor, `cli-${key}-cursor`);
  assert.equal(loadRun(data, cursor).clientRunId, cursor);
  saveRun(data, cursor, { runId: 'r1' });
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'two']);
  now += 60_000;
  await runHook(ctx({ CURSOR_AGENT: '1' }), 'post-commit', dir);
  assert.equal(loadRun(data, cursor).generation, 0);
  now += IDLE_MS + 1;
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'three']);
  await runHook(ctx({ CURSOR_AGENT: '1' }), 'post-commit', dir);
  assert.equal(loadRun(data, cursor).clientRunId, `${cursor}.1`);
  assert.ok(readOutbox(data).some((e) => e.kind === 'finish' && e.sessionId === `${cursor}--w0`));
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'four']);
  await runHook(ctx({ CLINE_ACTIVE: '1' }), 'post-commit', dir);
  assert.equal(loadRun(data, cursor).ended, true);
  assert.equal(loadRun(data, sessionOf(key, 'cline')).start.agent_kind, 'cline');
});

test('a live Claude Code session in the worktree keeps the CLI quiet until the session ends', async () => {
  const dir = repo();
  const data = cliData();
  const plugin = cliData();
  updateRepo(data, dir, { agent: 'cursor' });
  const pctx = { data: plugin, env: {}, harness: 'claude', now: Date.now, spawnFlush: () => {}, reconcile: async () => ({ enqueued: 0 }) };
  await handle('SessionStart', { session_id: 'cc1', cwd: dir, source: 'startup' }, pctx);
  assert.equal(liveSession(liveDirOf(dir), Date.now()), 'cc1');
  assert.equal(await runHook(ctxOf(data), 'post-commit', dir), 'quiet');
  assert.equal(await runHook(ctxOf(data), 'pre-push', dir), 'quiet');
  assert.deepEqual(readOutbox(data), []);
  const quietSha = git(dir, ['rev-parse', 'HEAD']).trim();
  assert.ok(loadWorktree(data, worktreeOf(dir).key).reportedCommits.includes(quietSha));
  await handle('SessionEnd', { session_id: 'cc1', cwd: dir }, pctx);
  assert.equal(liveSession(liveDirOf(dir), Date.now()), null);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'after']);
  assert.equal(await runHook(ctxOf(data), 'post-commit', dir), 'queued');
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
  assert.equal(readFileSync(fake.calls, 'utf8'), `hook post-commit --data ${fake.data}\n`);
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
    'pre-push': '#!/usr/bin/env bash\nexit 0',
    'post-checkout': '#!/usr/bin/env python3\nprint("hi")\n',
  };
  for (const [n, text] of Object.entries(files)) writeFileSync(join(hooks, n), text, { mode: 0o750 });
  const before = Object.fromEntries(Object.keys(files).map((n) => [n, bytes(join(hooks, n))]));
  const { done, skipped } = install(dir, fakeLauncher());
  assert.deepEqual([done, skipped], [['post-commit', 'pre-push'], ['post-checkout']]);
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
  installCopy(data, { from: join(data, 'bin', '9.9.9'), version: '9.9.9' });
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

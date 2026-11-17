import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { taskFor } from '../../lib/detect.mjs';
import { handle } from '../../lib/run.mjs';
import { readOutbox } from '../../lib/outbox.mjs';
import { saveWorktree, saveRun, worktreeOf } from '../../lib/state.mjs';

const tmp = (p) => realpathSync.native(mkdtempSync(join(tmpdir(), `eocrm-${p}-`)));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();

function repo(branch, name) {
  const dir = name ? join(tmp('parent'), name) : tmp('repo');
  execFileSync('mkdir', ['-p', dir]);
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

const link = (data, dir, taskKey) => saveWorktree(data, worktreeOf(dir).key, { root: dir, taskKey });
const bash = (cwd, command, extra = {}) => ({ session_id: 's', cwd, tool_name: 'Bash', tool_input: { command }, ...extra });
const resolveTask = (data, input, run = {}, ctx = {}) => taskFor({ data, ...ctx }, input)(run);

test('level 1: the hook cwd worktree link wins over its branch and the session task', () => {
  const data = tmp('data');
  const dir = repo('EO-2-branch');
  link(data, dir, 'EO-1');
  assert.equal(resolveTask(data, { session_id: 's', cwd: dir }, { start: { task: 'EO-3' } }), 'EO-1');
});

test('level 1: a leading cd picks the worktree the command ran in', () => {
  const data = tmp('data');
  const here = repo('main');
  const there = repo('main');
  link(data, there, 'EO-7');
  assert.equal(resolveTask(data, bash(here, `cd ${there} && make test`)), 'EO-7');
  assert.equal(resolveTask(data, bash(here, `cd "${there}"; make test`)), 'EO-7');
});

test('level 2: cd /x/eocrm-b1-eo92 && make test → the branch key EO-92', () => {
  const data = tmp('data');
  const wt = repo('b1/EO-92-fix', 'eocrm-b1-eo92');
  assert.equal(resolveTask(data, bash(tmp('elsewhere'), `cd ${wt} && make test`), { start: { task: 'EO-3' } }), 'EO-92');
});

test('level 2: a relative cd resolves against the hook cwd', () => {
  const data = tmp('data');
  const wt = repo('EO-92-fix', 'eocrm-b1-eo92');
  assert.equal(resolveTask(data, bash(join(wt, '..'), `cd ${basename(wt)} && make test`)), 'EO-92');
});

test('level 3: an unlinked worktree on a keyless branch falls back to the session task', () => {
  const data = tmp('data');
  assert.equal(resolveTask(data, bash(repo('main'), 'make test'), { start: { task: 'EO-3' } }), 'EO-3');
});

test('level 4: nothing resolves → null', () => {
  const data = tmp('data');
  assert.equal(resolveTask(data, bash(repo('main'), 'make test')), null);
});

test('a cd to a path that does not exist skips the worktree levels', () => {
  const data = tmp('data');
  const here = repo('EO-5-x');
  link(data, here, 'EO-5');
  assert.equal(resolveTask(data, bash(here, 'cd /nonexistent/eocrm-EO-9 && make test'), { start: { task: 'EO-3' } }), 'EO-3');
});

test('the worktree is cached per session, the branch is not: no git on the second call, a git switch changes the key', () => {
  const data = tmp('data');
  const wt = repo('EO-92-fix');
  let calls = 0;
  const ctx = { git: { exec: (cmd, args, opts) => { calls++; return execFileSync(cmd, args, opts); } } };
  assert.equal(resolveTask(data, bash(wt, 'make test'), {}, ctx), 'EO-92');
  assert.ok(calls > 0);
  const first = calls;
  assert.equal(resolveTask(data, bash(wt, 'make test'), {}, ctx), 'EO-92');
  assert.equal(calls, first);
  git(wt, 'switch', '-q', '-c', 'EO-93-next');
  assert.equal(resolveTask(data, bash(wt, 'make test'), {}, ctx), 'EO-93');
  assert.equal(calls, first);
  git(wt, 'switch', '-q', '--detach');
  assert.equal(resolveTask(data, bash(wt, 'make test'), { start: { task: 'EO-3' } }, ctx), 'EO-3');
});

test('a failed git lookup is not cached', () => {
  const data = tmp('data');
  const wt = repo('EO-92-fix');
  let fail = true;
  const ctx = { git: { exec: (cmd, args, opts) => { if (fail) throw new Error('timeout'); return execFileSync(cmd, args, opts); } } };
  assert.equal(resolveTask(data, bash(wt, 'make test'), {}, ctx), null);
  fail = false;
  assert.equal(resolveTask(data, bash(wt, 'make test'), {}, ctx), 'EO-92');
});

test('cd - and a bare cd leave the directory unknown: the worktree levels are skipped', () => {
  const data = tmp('data');
  const here = repo('EO-5-x');
  link(data, here, 'EO-5');
  for (const c of ['cd - && make test', 'cd && make test', 'cd; make test']) {
    assert.equal(resolveTask(data, bash(here, c), { start: { task: 'EO-3' } }), 'EO-3', c);
    assert.equal(resolveTask(data, bash(here, c)), null, c);
  }
});

test('pruning a run removes its paths cache', async () => {
  const { runsOf } = await import('../../lib/run.mjs');
  const { utimesSync, existsSync } = await import('node:fs');
  const data = tmp('data');
  resolveTask(data, { ...bash(repo('EO-1-x'), 'true'), session_id: 'old' });
  const paths = join(data, 'paths', 'old.json');
  assert.ok(existsSync(paths));
  saveRun(data, 'old', { startedAt: 1, ended: true, worktreeKey: 'k' });
  const at = Date.now();
  utimesSync(join(data, 'runs', 'old.json'), new Date(at - 8 * 86400e3), new Date(at - 8 * 86400e3));
  runsOf(data, 'k', { sid: 'now', at, busy: new Set() });
  assert.equal(existsSync(join(data, 'runs', 'old.json')), false);
  assert.equal(existsSync(paths), false);
});

test('a commit after a leading cd is read from that worktree', async () => {
  const data = tmp('data');
  writeFileSync(join(data, 'account.json'), JSON.stringify({ region: 'eu', workspace: 'acme', workspaces: { acme: 'standalone' } }));
  const main = repo('main');
  const sub = repo('main', 'eocrm-b1-eo92');
  git(sub, 'switch', '-q', '-c', 'EO-92-fix');
  git(sub, 'commit', '-q', '--allow-empty', '-m', 'in sub');
  const ctx = { data, env: { EOCRM_ENDPOINTS: JSON.stringify({ issuer: 'http://127.0.0.1:9', api: 'http://127.0.0.1:9/{workspace}/api' }) }, now: () => 1e12, spawnFlush: () => {}, reconcile: async () => ({ enqueued: 0 }) };
  saveRun(data, 'sess', { startedAt: 1, generation: 0, clientRunId: 'c', runId: 'r1', lastHeartbeatAt: 1e12, workspace: 'acme', region: 'eu', worktreeKey: worktreeOf(main).key, cwd: main });
  await handle('PostToolUse', { session_id: 'sess', cwd: main, transcript_path: join(main, 'none.jsonl'), hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: `cd ${sub} && git commit -m x` }, tool_response: { stdout: '', stderr: '' } }, ctx);
  const commits = readOutbox(data).filter((e) => e.event?.type === 'commit').map((e) => [e.event.subject, e.event.task_key]);
  assert.deepEqual(commits, [['in sub', 'EO-92']]);
});

test('Codex workdir names the directory a shell call ran in', () => {
  const data = tmp('data');
  const wt = repo('EO-44-x');
  assert.equal(resolveTask(data, { session_id: 's', cwd: tmp('w'), tool_name: 'Bash', tool_input: { command: 'make test', workdir: wt } }), 'EO-44');
});

test('every queued event carries task_key; a subagent call in another worktree gets that worktree\'s task', async () => {
  const data = tmp('data');
  writeFileSync(join(data, 'account.json'), JSON.stringify({ region: 'eu', workspace: 'acme', workspaces: { acme: 'standalone' } }));
  const main = repo('main');
  const sub = repo('EO-92-fix', 'eocrm-b1-eo92');
  const ctx = { data, env: { EOCRM_ENDPOINTS: JSON.stringify({ issuer: 'http://127.0.0.1:9', api: 'http://127.0.0.1:9/{workspace}/api' }) }, now: () => 1e12, spawnFlush: () => {}, reconcile: async () => ({ enqueued: 0 }) };
  saveRun(data, 'sess', { startedAt: 1, generation: 0, clientRunId: 'c', runId: 'r1', lastHeartbeatAt: 1e12, workspace: 'acme', region: 'eu', worktreeKey: worktreeOf(main).key, cwd: main, start: { task: 'EO-3' } });
  const fire = (event, extra) => handle(event, { session_id: 'sess', cwd: main, transcript_path: join(main, 'none.jsonl'), hook_event_name: event, ...extra }, ctx);
  await fire('UserPromptSubmit', {});
  await fire('PostToolUse', { cwd: sub, tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'make test', description: 'test: unit' }, tool_response: { stdout: '3 passed', stderr: '' } });
  await fire('PostToolUse', { tool_name: 'Bash', tool_use_id: 't2', tool_input: { command: `cd ${sub} && make test`, description: 'test: unit' }, tool_response: { stdout: '3 passed', stderr: '' } });
  const events = readOutbox(data).filter((e) => e.kind === 'event').map((e) => e.event);
  assert.deepEqual(events.map((e) => [e.type, e.task_key]), [['turn', 'EO-3'], ['test_run', 'EO-92'], ['test_run', 'EO-92']]);
});

test('Codex shell calls keep their workdir through normalisation', async () => {
  const { codexEvents } = await import('../../lib/codex.mjs');
  const [, post] = codexEvents('PostToolUse', { cwd: '/w', tool_name: 'exec_command', tool_input: { cmd: 'make test', workdir: '/x/eocrm-b1-eo92' } });
  assert.equal(post.input.tool_input.workdir, '/x/eocrm-b1-eo92');
});

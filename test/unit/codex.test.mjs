import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { codexEvents } from '../../lib/codex.mjs';
import { testRun, isCommit } from '../../lib/detect.mjs';
import { handle } from '../../lib/run.mjs';
import { loadRun, saveRun } from '../../lib/state.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/codex/${name}.json`, import.meta.url), 'utf8'));
const tmp = (p) => realpathSync.native(mkdtempSync(join(tmpdir(), `eocrm-${p}-`)));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
const shell = (command, tool_response = '') => ({ session_id: 's', cwd: '/w', tool_name: 'shell', tool_use_id: 'c1', tool_input: { command }, tool_response });
const only = (event, input) => {
  const out = codexEvents(event, input);
  assert.equal(out[0].event, event);
  return out[0].input;
};

test('maps PermissionRequest to a permission waiting notification', () => {
  const out = codexEvents('PermissionRequest', fixture('permission-request'));
  assert.deepEqual(out.map((e) => e.event), ['Notification']);
  assert.equal(out[0].input.notification_type, 'permission_prompt');
  assert.equal(out[0].input.session_id, 'cx-1');
});

test('PostToolUse also resumes', () => {
  assert.deepEqual(codexEvents('PostToolUse', fixture('post-tool-use-shell')).map((e) => e.event), ['PostToolUse', 'Resume']);
  assert.deepEqual(codexEvents('PreToolUse', fixture('post-tool-use-shell')).map((e) => e.event), ['PreToolUse']);
});

test('session and prompt events map to themselves; Stop drops the reply text', () => {
  for (const e of ['SessionStart', 'SessionEnd', 'UserPromptSubmit']) assert.deepEqual(codexEvents(e, { cwd: '/w' }).map((x) => x.event), [e]);
  assert.equal(codexEvents('UserPromptSubmit', { cwd: '/w', prompt: 'p' })[0].input.prompt, undefined);
  const stop = codexEvents('Stop', fixture('stop'));
  assert.deepEqual(stop.map((e) => e.event), ['Stop']);
  assert.ok(!JSON.stringify(stop).includes('SECRET-REPLY'));
});

test('normalises a string shell command', () => {
  const input = only('PostToolUse', shell('git commit -m x'));
  assert.equal(input.tool_name, 'Bash');
  assert.equal(input.tool_input.command, 'git commit -m x');
  assert.equal(only('PostToolUse', { ...shell(), tool_name: 'exec_command', tool_input: { cmd: 'ls -la' } }).tool_input.command, 'ls -la');
});

test('normalises an argv shell command', () => {
  for (const argv of [['bash', '-lc', 'git commit -m x'], ['/bin/sh', '-c', 'git commit -m x']]) {
    const input = only('PostToolUse', shell(argv));
    assert.equal(input.tool_input.command, 'git commit -m x');
    assert.ok(isCommit(input.tool_input.command));
  }
  assert.equal(only('PostToolUse', shell(['git', 'commit', '-m', 'two words'])).tool_input.command, "git commit -m 'two words'");
});

test('maps shell output to the detector shape', () => {
  const r = testRun({ ...only('PostToolUse', fixture('post-tool-use-shell')), hook_event_name: 'PostToolUse' });
  assert.equal(r.command, 'npm test');
  assert.equal(r.result_line, '# fail 1');
  assert.equal(r.exit_code, 1);
  const s = testRun({ ...only('PostToolUse', shell('npm test', { stdout: 'ok 1\n# pass 1', exitCode: 0 })), hook_event_name: 'PostToolUse' });
  assert.deepEqual([s.result_line, s.exit_code], ['# pass 1', 0]);
  const str = testRun({ ...only('PostToolUse', shell('npm test', 'tests 2 passed')), hook_event_name: 'PostToolUse' });
  assert.deepEqual([str.result_line, str.exit_code], ['tests 2 passed', 0]);
});

test('apply_patch paths are parsed from add, update and move lines', () => {
  const input = only('PostToolUse', fixture('apply-patch'));
  assert.equal(input.tool_name, 'Write');
  assert.deepEqual(input.tool_input.file_paths, ['/w/src/new.js', '/w/src/old.js', '/w/src/moved.js']);
});

test('update_plan becomes todos', () => {
  const input = only('PostToolUse', fixture('update-plan'));
  assert.equal(input.tool_name, 'TodoWrite');
  assert.deepEqual(input.tool_input.todos, [
    { content: 'Read code', status: 'completed' },
    { content: 'Write tests', status: 'in_progress' },
    { content: 'Ship', status: 'pending' },
  ]);
});

test('unknown events map to nothing', () => {
  assert.deepEqual(codexEvents('PostModelRequest', { cwd: '/w' }), []);
  assert.deepEqual(codexEvents('Nope', { cwd: '/w' }), []);
});

test('apply_patch on the plan file triggers a sync', async () => {
  const PLAN = 'docs/superpowers/plans/p.md';
  const dir = tmp('repo');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dir, 'checkout', '-q', '-b', 'feat/AB-1-x');
  mkdirSync(join(dir, 'docs/superpowers/plans'), { recursive: true });
  writeFileSync(join(dir, PLAN), '# P\n\n### Task 1: One\n- [ ] a\n');
  const data = tmp('data');
  writeFileSync(join(data, 'account.json'), JSON.stringify({ region: 'eu', workspace: 'acme', workspaces: { acme: 'standalone' } }));
  const calls = [];
  const ctx = {
    data, harness: 'codex', now: () => 1_000_000, spawnFlush: () => {},
    env: { EOCRM_ENDPOINTS: JSON.stringify({ issuer: 'http://127.0.0.1:9', api: 'http://127.0.0.1:9/{workspace}/api' }) },
    reconcile: async (c, run) => (calls.push(run.sessionId), { enqueued: 0 }),
  };
  const sid = `cx-${process.pid}`;
  const patch = (file) => handle('PostToolUse', { session_id: sid, cwd: dir, tool_name: 'apply_patch', tool_input: { input: `*** Begin Patch\n*** Update File: ${file}\n*** End Patch\n` }, tool_response: 'ok' }, ctx);
  await handle('SessionStart', { session_id: sid, cwd: dir, source: 'startup' }, ctx);
  assert.equal(calls.length, 1);
  saveRun(data, sid, { planPath: PLAN });
  await patch('notes.md');
  assert.equal(calls.length, 1);
  await patch(PLAN);
  assert.equal(calls.length, 2);
  await patch('.superpowers/sdd/p/progress.md');
  assert.equal(calls.length, 3);
  assert.deepEqual(loadRun(data, sid).written, ['notes.md', PLAN, '.superpowers/sdd/p/progress.md'].map((f) => join(dir, f)));
});

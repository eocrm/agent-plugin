import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { remind, linkedLine, promptLine } from '../../lib/remind.mjs';
import { handle, LINK_ASK } from '../../lib/run.mjs';
import { loadRun, saveRun, withLock } from '../../lib/state.mjs';
import { main } from '../../scripts/eocrm.mjs';

const tmp = (p) => realpathSync.native(mkdtempSync(join(tmpdir(), `eocrm-${p}-`)));
const UNREACHABLE = JSON.stringify({ issuer: 'http://127.0.0.1:9', api: 'http://127.0.0.1:9/{workspace}/api' });
let n = 0;

function setup({ task = 'EO-1', conventions, lastStopAt } = {}) {
  const data = tmp('data');
  const sid = `remind-${process.pid}-${++n}`;
  saveRun(data, sid, { startedAt: 1, workspace: 'acme', region: 'eu', start: task ? { task } : {}, ...(conventions ? { conventions } : {}), ...(lastStopAt ? { lastStopAt } : {}) });
  const ctx = { data, now: () => ctx.at, at: 100 * 60_000 };
  const fire = async (event, extra = {}) => {
    const { stdout } = await remind(ctx, event, { session_id: sid, cwd: data, ...extra });
    return stdout ? JSON.parse(stdout).hookSpecificOutput : null;
  };
  return { data, sid, ctx, fire };
}

const bash = (command) => ['PostToolUse', { tool_name: 'Bash', tool_input: { command } }];
const tool = (name, tool_input = {}) => ['PostToolUse', { tool_name: `mcp__plugin_eocrm-mcp_eocrm__tasks_${name}`, tool_input }];
const every = { task_switch_check: 'every_prompt' };

test('remind is silent without a run', async () => {
  const data = tmp('data');
  const ctx = { data, now: () => 0 };
  for (const [event, input] of [['UserPromptSubmit', {}], bash('git checkout -b x'), tool('create')]) {
    assert.deepEqual(await remind(ctx, event, { session_id: 'none', cwd: data, ...input }), {});
  }
  const { data: d2, sid, fire } = setup({ conventions: every });
  assert.ok(await fire('UserPromptSubmit'));
  saveRun(d2, sid, { workspace: null });
  assert.equal(await fire('UserPromptSubmit'), null);
});

test('new branch reminds once per task', async () => {
  const { data, sid, fire } = setup();
  assert.deepEqual(await fire(...bash('git checkout -b feat/x')), { hookEventName: 'PostToolUse', additionalContext: linkedLine('EO-1') });
  assert.equal(await fire(...bash('git switch -c feat/y')), null);
  assert.equal(await fire(...bash('git status')), null);
  saveRun(data, sid, { start: { task: 'EO-2' } });
  assert.equal(await fire(...bash('git checkout main')), null);
  assert.equal((await fire(...bash('git worktree add ../w -b feat/z')))?.additionalContext, linkedLine('EO-2'));
  saveRun(data, sid, { start: { task: 'EO-3' } });
  assert.equal((await fire(...bash('git switch -c z')))?.additionalContext, linkedLine('EO-3'));
  const unlinked = setup({ task: null });
  assert.equal(await unlinked.fire(...bash('git checkout -b feat/x')), null);
});

test('tasks_create reminds; move_stage on the linked key does not', async () => {
  const { fire } = setup();
  assert.equal(await fire('PostToolUse', { tool_name: 'mcp__other__tasks_create', tool_input: {} }), null);
  assert.equal(await fire(...tool('move_stage', { id: 'EO-1', stage_key: 'done' })), null);
  assert.equal(await fire(...tool('update', { key: 'EO-1' })), null);
  assert.equal((await fire(...tool('create', { title: 't' })))?.additionalContext, linkedLine('EO-1'));
  assert.equal(await fire(...tool('create', { title: 'u' })), null);
  assert.equal((await fire(...tool('update', { id: 'EO-7' })))?.additionalContext, linkedLine('EO-1'));
  assert.equal(await fire(...tool('move_stage', { id: 'EO-7' })), null);
  assert.equal((await fire(...tool('move_stage', { id: 'EO-8' })))?.additionalContext, linkedLine('EO-1'));
  const unlinked = setup({ task: null });
  assert.equal(await unlinked.fire(...tool('create')), null);
});

test('a held lock makes a tool signal print nothing and stay unrecorded', async () => {
  const { data, sid, fire } = setup();
  const started = Date.now();
  assert.equal(await withLock(data, () => fire(...bash('git checkout -b x'))), null);
  assert.ok(Date.now() - started < 1500);
  assert.equal(loadRun(data, sid).reminded, undefined);
  assert.ok(await fire(...bash('git checkout -b x')));
});

test('every_prompt reminds each prompt', async () => {
  const { fire } = setup({ conventions: every });
  for (let i = 0; i < 3; i++) assert.deepEqual(await fire('UserPromptSubmit'), { hookEventName: 'UserPromptSubmit', additionalContext: promptLine('EO-1') });
});

test('after_pause reminds only after 10 idle minutes', async () => {
  const { data, sid, ctx, fire } = setup({ conventions: { task_switch_check: 'after_pause' } });
  assert.equal(await fire('UserPromptSubmit'), null);
  saveRun(data, sid, { lastStopAt: ctx.at - 10 * 60_000 + 1 });
  assert.equal(await fire('UserPromptSubmit'), null);
  saveRun(data, sid, { lastStopAt: ctx.at - 10 * 60_000 });
  assert.equal((await fire('UserPromptSubmit'))?.additionalContext, promptLine('EO-1'));
});

test('after_pause reminds once per pause', async () => {
  const { ctx, fire } = setup({ conventions: { task_switch_check: 'after_pause' }, lastStopAt: 100 * 60_000 - 11 * 60_000 });
  assert.equal((await fire('UserPromptSubmit'))?.additionalContext, promptLine('EO-1'));
  ctx.at += 6000;
  assert.equal(await fire('UserPromptSubmit'), null);
});

test('a ULID or lower-case key of the linked task does not remind', async () => {
  const { fire } = setup();
  assert.equal(await fire(...tool('update', { id: '01J9ZQ4X7W8V6T5S4R3Q2P1N0M' })), null);
  assert.equal(await fire(...tool('move_stage', { key: 'eo-1' })), null);
  assert.equal((await fire(...tool('update', { id: 'eo-7' })))?.additionalContext, linkedLine('EO-1'));
  assert.equal(await fire(...tool('update', { id: 'EO-7' })), null);
});

test('a non-string id does not remind', async () => {
  const { fire } = setup();
  for (const id of [7, { key: 'EO-7' }, ['EO-7'], undefined]) assert.equal(await fire(...tool('update', { id })), null);
});

test('prompt reminder still prints when its bookkeeping write fails', async () => {
  const { data, sid, fire } = setup({ conventions: { task_switch_check: 'after_pause' }, lastStopAt: 1 });
  chmodSync(join(data, 'runs'), 0o555);
  try {
    assert.equal((await fire('UserPromptSubmit'))?.additionalContext, promptLine('EO-1'));
  } finally {
    chmodSync(join(data, 'runs'), 0o755);
  }
  assert.equal(loadRun(data, sid).promptRemindedAt, undefined);
  assert.match(readFileSync(join(data, 'plugin.log'), 'utf8'), /EACCES/);
});

test('a held lock still prints the prompt reminder, unrecorded', async () => {
  const { data, sid, fire } = setup({ conventions: { task_switch_check: 'after_pause' }, lastStopAt: 1 });
  assert.equal((await withLock(data, () => fire('UserPromptSubmit')))?.additionalContext, promptLine('EO-1'));
  assert.equal(loadRun(data, sid).promptRemindedAt, undefined);
});

test('signals_only never reminds on a prompt', async () => {
  const { fire } = setup({ conventions: { task_switch_check: 'signals_only' }, lastStopAt: 1 });
  assert.equal(await fire('UserPromptSubmit'), null);
  assert.ok(await fire(...bash('git checkout -b x')));
});

test('unknown setting acts as after_pause', async () => {
  for (const conventions of [{ task_switch_check: 'sometimes' }, {}, undefined]) {
    const { data, sid, ctx, fire } = setup({ conventions });
    assert.equal(await fire('UserPromptSubmit'), null);
    saveRun(data, sid, { lastStopAt: ctx.at - 10 * 60_000 });
    assert.equal((await fire('UserPromptSubmit'))?.additionalContext, promptLine('EO-1'));
  }
});

test('unlinked prompt uses the unlinked copy', async () => {
  const { fire } = setup({ task: null, conventions: every });
  assert.equal((await fire('UserPromptSubmit'))?.additionalContext, promptLine(null));
  assert.match(promptLine(null), /isn't linked to a task/);
});

test('remind never reads the prompt', async () => {
  const { fire } = setup({ conventions: every });
  const out = await fire('UserPromptSubmit', { prompt: 'Work on EO-9 instead', last_assistant_message: 'EO-9', tool_response: 'EO-9' });
  assert.ok(out);
  assert.ok(!JSON.stringify(out).includes('EO-9'));
  const tools = await fire('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'git checkout -b x' }, prompt: 'EO-9', tool_response: { stdout: 'EO-9' } });
  assert.ok(tools);
  assert.ok(!JSON.stringify(tools).includes('EO-9'));
});

test('Stop records lastStopAt', async () => {
  const { data, sid, ctx } = setup();
  const dir = tmp('repo');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeFileSync(join(data, 'account.json'), JSON.stringify({ region: 'eu', workspace: 'acme', workspaces: { acme: 'standalone' } }));
  ctx.env = { EOCRM_ENDPOINTS: UNREACHABLE };
  ctx.spawnFlush = () => {};
  ctx.reconcile = async () => ({});
  ctx.clientFor = () => ({});
  await handle('SessionStart', { session_id: sid, cwd: dir, source: 'startup' }, ctx);
  await handle('Stop', { session_id: sid, cwd: dir }, ctx);
  assert.equal(loadRun(data, sid).lastStopAt, ctx.at);
});

test('linked resume adds the linked line', async () => {
  const data = tmp('data');
  writeFileSync(join(data, 'account.json'), JSON.stringify({ region: 'eu', workspace: 'acme', workspaces: { acme: 'standalone' } }));
  const dir = tmp('repo');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await main({ argv: ['link', 'AB-3', '--data', data], cwd: dir, env: {}, out: () => {}, err: () => {} });
  const ctx = { data, env: { EOCRM_ENDPOINTS: UNREACHABLE }, now: () => 1_000_000, spawnFlush: () => {}, reconcile: async () => ({}) };
  const context = async (source) => JSON.parse((await handle('SessionStart', { session_id: `ss-${source}`, cwd: dir, source }, ctx)).stdout ?? 'null')?.hookSpecificOutput?.additionalContext;
  for (const source of ['startup', 'resume', 'clear']) assert.equal(await context(source), linkedLine('AB-3'));
  for (const source of ['compact', 'fork']) assert.equal(await context(source), undefined);
  const unlinked = tmp('repo');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: unlinked });
  const ask = await handle('SessionStart', { session_id: 'ss-unlinked', cwd: unlinked, source: 'startup' }, ctx);
  assert.equal(JSON.parse(ask.stdout).hookSpecificOutput.additionalContext, LINK_ASK);
});

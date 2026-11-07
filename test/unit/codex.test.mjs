import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { codexEvents, addModelUsage } from '../../lib/codex.mjs';
import { testRun, isCommit, prEvent } from '../../lib/detect.mjs';
import { handle, spawnFlush } from '../../lib/run.mjs';
import { parseArgs } from '../../lib/paths.mjs';
import { loadRun, saveRun } from '../../lib/state.mjs';
import { readOutbox } from '../../lib/outbox.mjs';
import { eventId } from '../../lib/ids.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/codex/${name}.json`, import.meta.url), 'utf8'));
const tmp = (p) => realpathSync.native(mkdtempSync(join(tmpdir(), `eocrm-${p}-`)));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
const shell = (command, tool_response = '') => ({ session_id: 's', cwd: '/w', tool_name: 'shell', tool_use_id: 'c1', tool_input: { command }, tool_response });
const only = (event, input) => {
  const hit = codexEvents(event, input).find((e) => e.event === event);
  assert.ok(hit);
  return hit.input;
};

test('maps PermissionRequest to a permission waiting notification', () => {
  const out = codexEvents('PermissionRequest', fixture('permission-request'));
  assert.deepEqual(out.map((e) => e.event), ['Notification']);
  assert.equal(out[0].input.notification_type, 'permission_prompt');
  assert.equal(out[0].input.session_id, 'cx-1');
});

test('PostToolUse also resumes', () => {
  assert.deepEqual(codexEvents('PostToolUse', fixture('post-tool-use-shell')).map((e) => e.event), ['Resume', 'PostToolUse']);
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

test('unwraps a shell with extra flags', () => {
  for (const argv of [['bash', '-e', '-lc', 'git commit -m x'], ['bash', '--noprofile', '-ec', 'git commit -m x']]) {
    assert.equal(only('PostToolUse', shell(argv)).tool_input.command, 'git commit -m x');
  }
  assert.equal(only('PostToolUse', shell(['bash', '--rcfile', 'x'])).tool_input.command, 'bash --rcfile x');
});

test('maps shell output to the detector shape', () => {
  const r = testRun({ ...only('PostToolUse', fixture('post-tool-use-shell')), hook_event_name: 'PostToolUse' });
  assert.equal(r.command, 'npm test');
  assert.equal(r.result_line, '# fail 1');
  assert.equal(r.exit_code, 1);
  const s = testRun({ ...only('PostToolUse', shell('npm test', { stdout: 'ok 1\n# pass 1', exitCode: 0 })), hook_event_name: 'PostToolUse' });
  assert.deepEqual([s.result_line, s.exit_code], ['# pass 1', 0]);
  for (const field of ['aggregated_output', 'formatted_output']) {
    assert.equal(testRun({ ...only('PostToolUse', shell('npm test', { [field]: '# pass 2', exit_code: 0 })), hook_event_name: 'PostToolUse' }).result_line, '# pass 2');
  }
  const str = testRun({ ...only('PostToolUse', shell('npm test', 'tests 2 passed')), hook_event_name: 'PostToolUse' });
  assert.deepEqual([str.result_line, str.exit_code], ['tests 2 passed', null]);
  assert.equal(testRun({ ...only('PostToolUse', shell('npm test', { output: '# pass 1' })), hook_event_name: 'PostToolUse' }).exit_code, null);
});

test('real Codex Bash: string command and output, exit unknown', () => {
  const real = fixture('real-bash');
  const input = only('PostToolUse', { ...real, tool_input: { command: 'npm test' }, tool_response: '# pass 3\n' });
  assert.deepEqual(input.tool_response, { stdout: '# pass 3\n', stderr: '', exit: null });
  const r = testRun(input);
  assert.deepEqual([r.command, r.result_line, r.exit_code], ['npm test', '# pass 3', null]);
  assert.equal(only('PostToolUse', real).tool_input.command, real.tool_input.command);
});

test('real Codex apply_patch: paths from tool_input.command', () => {
  const input = only('PostToolUse', fixture('real-apply-patch'));
  assert.equal(input.tool_name, 'Write');
  assert.deepEqual(input.tool_input.file_paths, ['/w/notes.txt']);
});

test('real Codex token_usage: input excludes cached, cache writes counted', () => {
  const u = fixture('real-post-model-request');
  assert.deepEqual(addModelUsage({}, u).codexUsage['gpt-6.1-sol'], { input_tokens: 15378 - 12288, output_tokens: 242, cache_read_tokens: 12288, cache_write_tokens: 0 });
  const w = addModelUsage({}, { ...u, token_usage: { ...u.token_usage, input_tokens: 5, cache_write_input_tokens: 7 } }).codexUsage['gpt-6.1-sol'];
  assert.deepEqual([w.input_tokens, w.cache_write_tokens], [0, 7]);
});

test('Remind maps to itself with the tool normalised', () => {
  const [r] = codexEvents('Remind', { ...fixture('real-bash'), prompt: 'p' });
  assert.equal(r.event, 'Remind');
  assert.equal(r.input.tool_name, 'Bash');
  assert.equal(r.input.prompt, undefined);
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

function usageSetup(harness = 'codex') {
  const data = tmp('data');
  saveRun(data, 's', { startedAt: 1, generation: 0, runId: 'r1', lastHeartbeatAt: 1e12 });
  const refused = { status: 503, body: null };
  const client = { recordEvents: async () => refused, startRun: async () => refused, heartbeat: async () => refused, updateRun: async () => refused };
  const spawned = [];
  const ctx = { data, harness, env: {}, now: () => 1e12, spawnFlush: () => spawned.push(1), clientFor: () => client, reconcile: async () => ({ enqueued: false }) };
  const fire = (event, extra = {}) => handle(event, { session_id: 's', cwd: data, transcript_path: null, ...extra }, ctx);
  const model = (model, token_usage, status = 'completed') => fire('PostModelRequest', { model, status, token_usage, prompt: 'SECRET' });
  const events = () => readOutbox(data).filter((e) => e.kind === 'event').map((e) => e.event);
  const usage = () => events().filter((e) => e.type === 'usage' && e.input_tokens !== undefined);
  return { data, fire, model, events, usage, spawned };
}
const U = { input_tokens: 110, output_tokens: 5, reasoning_output_tokens: 2, cached_input_tokens: 100 };
const shape = (events) => events.map(({ type, kind, phase }) => [type, kind ?? phase ?? null]);

test('sums PostModelRequest usage per model', async () => {
  const { data, model, spawned } = usageSetup();
  await model('gpt-a', U);
  await model('gpt-a', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 });
  await model('gpt-b', { input_tokens: 2 });
  assert.deepEqual(loadRun(data, 's').codexUsage, {
    'gpt-a': { input_tokens: 11, output_tokens: 8, cache_read_tokens: 103, cache_write_tokens: 4 },
    'gpt-b': { input_tokens: 2, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
  });
  assert.equal(spawned.length, 0);
  assert.equal(addModelUsage({}, { model: 'gpt-a', status: 'completed' }), null);
});

test('ignores failed or cancelled model requests', async () => {
  const { data, model } = usageSetup();
  await model('gpt-a', U, 'failed');
  await model('gpt-a', U, 'cancelled');
  await model('gpt-a', U, null);
  assert.equal(loadRun(data, 's').codexUsage, undefined);
});

test('Stop sends one usage event per model and resets the sums', async () => {
  const { data, fire, model, usage } = usageSetup();
  await model('gpt-a', U);
  await model('gpt-b', { input_tokens: 2 });
  await model('gpt-c', { input_tokens: 0, output_tokens: 0 });
  await fire('Stop', { turn_id: 't1' });
  const first = usage();
  assert.deepEqual(first.map((e) => [e.model, e.input_tokens, e.output_tokens, e.cache_read_tokens, e.cache_write_tokens]), [['gpt-a', 10, 7, 100, 0], ['gpt-b', 2, 0, 0, 0]]);
  assert.equal(first[0].id, eventId('usage', 's:0:codex:t1:0:gpt-a'));
  assert.deepEqual(loadRun(data, 's').codexUsage, {});
  await fire('Stop', { turn_id: 't1' });
  assert.equal(usage().length, 2);
  await model('gpt-a', U);
  await fire('Stop', { turn_id: 't2' });
  assert.equal(usage().length, 3);
  assert.notEqual(usage()[2].id, first[0].id);
});

test('a retried Stop reuses the turn\'s usage event ids', async () => {
  const { data, fire, model, usage } = usageSetup();
  await model('gpt-a', U);
  const sums = loadRun(data, 's').codexUsage;
  await fire('Stop', { turn_id: 't1' });
  const first = usage().map((e) => e.id);
  saveRun(data, 's', { codexUsage: sums, codexStops: 0 });
  await fire('Stop', { turn_id: 't1' });
  assert.deepEqual(usage().map((e) => e.id), first);
});

test('Stop queues idle waiting only when the gate lets the turn end', async () => {
  const { data, fire, events } = usageSetup();
  await fire('UserPromptSubmit');
  await fire('Stop', { turn_id: 't1' });
  assert.deepEqual(shape(events()), [['turn', 'started'], ['turn', 'ended'], ['waiting', 'idle']]);
  assert.equal(events()[2].id, eventId('waiting', 's:0:0'));
  assert.equal(loadRun(data, 's').waiting, true);
});

test('the next prompt resumes after idle', async () => {
  const { fire, events } = usageSetup();
  await fire('Stop', { turn_id: 't1' });
  await fire('UserPromptSubmit');
  assert.deepEqual(shape(events()).slice(-2), [['resumed', null], ['turn', 'started']]);
  assert.equal(events().at(-2).id, eventId('resumed', 's:0:0'));
});

test('claude Stop still reads usage from the transcript', async () => {
  const { data, fire, usage, events } = usageSetup('claude');
  const transcript = join(data, 't.jsonl');
  writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-x', usage: { input_tokens: 3, output_tokens: 1 } } })}\n`);
  saveRun(data, 's', { codexUsage: { 'gpt-a': { input_tokens: 9, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 } } });
  await fire('Stop', { transcript_path: transcript });
  assert.deepEqual(usage().map((e) => [e.model, e.input_tokens]), [['claude-x', 3]]);
  assert.ok(!events().some((e) => e.type === 'waiting'));
});

test('a blocked Stop and its continuation send distinct usage ids', async () => {
  const { fire, model, usage } = usageSetup();
  await fire('UserPromptSubmit');
  await model('gpt-a', U);
  await fire('Stop', { turn_id: 't1' });
  await model('gpt-a', U);
  await fire('Stop', { turn_id: 't1', stop_hook_active: true });
  assert.equal(new Set(usage().map((e) => e.id)).size, 2);
  await fire('UserPromptSubmit');
  await model('gpt-a', U);
  await fire('Stop', { turn_id: 't2' });
  assert.equal(usage().at(-1).id, eventId('usage', 's:0:codex:t2:0:gpt-a'));
});

test('a codex hook prints one JSON object and the gate decision wins', async () => {
  const block = JSON.stringify({ decision: 'block', reason: 'r' });
  const other = JSON.stringify({ hookSpecificOutput: { additionalContext: 'x' } });
  for (const [resume, post] of [[block, other], [other, block]]) {
    const ctx = { harness: 'codex', core: async (event) => ({ stdout: event === 'Resume' ? resume : post }) };
    const out = await handle('PostToolUse', { session_id: 's', cwd: '/w', tool_name: 'x' }, ctx);
    assert.equal(JSON.parse(out.stdout).decision, 'block');
  }
});

test('SessionEnd sends usage left over after the last Stop', async () => {
  const { data, fire, model, usage } = usageSetup();
  await fire('UserPromptSubmit');
  await model('gpt-a', U);
  await fire('Stop', { turn_id: 't1' });
  await model('gpt-a', { input_tokens: 4 });
  await fire('SessionEnd');
  assert.deepEqual(usage().map((e) => e.input_tokens), [10, 4]);
  assert.equal(new Set(usage().map((e) => e.id)).size, 2);
  const kinds = readOutbox(data).filter((e) => e.kind === 'finish' || e.event?.input_tokens === 4).map((e) => e.kind);
  assert.deepEqual(kinds, ['event', 'finish']);
  assert.deepEqual(loadRun(data, 's').codexUsage, {});
});

test('the detached flush keeps the codex harness', () => {
  const argv = (harness) => {
    let a;
    spawnFlush({ data: '/d', env: {}, harness, spawn: (_, args) => ((a = args), { on() { return this; }, unref() {} }) });
    return a.slice(1);
  };
  assert.deepEqual(parseArgs(argv('codex')), { event: 'flush', harness: 'codex' });
  assert.deepEqual(argv('claude'), ['flush', '--data', '/d']);
});

test('Codex gh pr merge/create are confirmed with GitHub because the exit code is unknown', () => {
  const url = 'https://github.com/o/r/pull/12';
  const post = (command, tool_response) => only('PostToolUse', { ...fixture('real-bash'), tool_input: { command }, tool_response });
  const failedMerge = post('gh pr merge 12 --squash', 'X Pull request o/r#12 is not mergeable.\n');
  const opts = (state) => ({ open: () => [{ branch: 'b', url }], branch: () => 'b', state: () => state });
  assert.equal(prEvent(failedMerge, opts('OPEN')), null);
  assert.equal(prEvent(failedMerge, opts(null)), null);
  assert.equal(prEvent(failedMerge, { open: () => [{ branch: 'b', url }], branch: () => 'b' }), null);
  assert.deepEqual(prEvent(failedMerge, opts('MERGED')), { action: 'merged', url, number: 12 });
  const create = post('gh pr create --fill', `${url}\n`);
  assert.equal(prEvent(create, { branch: () => 'b', state: () => 'CLOSED' }), null);
  assert.equal(prEvent(create, { branch: () => 'b', state: () => 'OPEN' }).action, 'opened');
  const exists = post('gh pr create --fill', `a pull request for branch "b" into branch "main" already exists:\n${url}\n`);
  assert.equal(prEvent(exists, { branch: () => 'b', state: () => 'OPEN' }), null);
  const chain = post('git checkout -b feat; git push -u origin feat; gh pr create --fill', `fatal: a branch named 'feat' already exists\n${url}\n`);
  assert.equal(prEvent(chain, { branch: () => 'feat', state: () => 'OPEN' }).action, 'opened');
  const claude = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr merge 12' }, tool_response: { stdout: '', stderr: '' } };
  assert.equal(prEvent(claude, { open: () => [{ branch: 'b', url }], state: () => null }).url, url);
});

test('a Codex gh pr merge is queued only when gh says MERGED', async () => {
  const url = 'https://github.com/o/r/pull/12';
  const merged = async (state) => {
    const dir = tmp('repo');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
    const data = tmp('data');
    writeFileSync(join(data, 'account.json'), JSON.stringify({ region: 'eu', workspace: 'acme', workspaces: { acme: 'standalone' } }));
    const exec = (cmd, args, opts) => (cmd === 'gh' ? (args.includes('state') ? `${state}\n` : '') : execFileSync(cmd, args, opts));
    const ctx = { data, harness: 'codex', now: () => 1_000_000, spawnFlush: () => {}, git: { exec }, env: {}, reconcile: async () => ({ enqueued: 0 }) };
    await handle('SessionStart', { session_id: 's', cwd: dir, source: 'startup' }, ctx);
    await handle('PostToolUse', { session_id: 's', cwd: dir, tool_name: 'Bash', tool_use_id: 'exec-1', tool_input: { command: `gh pr merge ${url}` }, tool_response: 'X not mergeable\n' }, ctx);
    return readOutbox(data).filter((e) => e.event?.type === 'pull_request').map((e) => e.event.action);
  };
  assert.deepEqual(await merged('OPEN'), []);
  assert.deepEqual(await merged('MERGED'), ['merged']);
});

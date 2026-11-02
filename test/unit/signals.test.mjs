import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handle } from '../../lib/run.mjs';
import { readOutbox } from '../../lib/outbox.mjs';
import { loadRun, saveRun } from '../../lib/state.mjs';

const SECRET = 'Claude needs your permission to use rm -rf /secret-path';

function setup(run = {}) {
  const data = realpathSync.native(mkdtempSync(join(tmpdir(), 'eocrm-signals-')));
  saveRun(data, 's', { startedAt: 1, generation: 0, runId: 'r1', lastHeartbeatAt: 1e12, ...run });
  const refused = { status: 503, body: null };
  const client = { recordEvents: async () => refused, startRun: async () => refused, heartbeat: async () => refused, updateRun: async () => refused };
  const ctx = { data, env: {}, now: () => 1e12, spawnFlush: () => {}, clientFor: () => client, reconcile: async () => ({ enqueued: false }) };
  const fire = (event, extra = {}) => handle(event, { session_id: 's', cwd: data, transcript_path: join(data, 'none.jsonl'), message: SECRET, title: SECRET, ...extra }, ctx);
  const events = () => readOutbox(data).filter((e) => e.kind === 'event').map((e) => e.event);
  return { data, fire, events };
}

const shape = (events) => events.map(({ type, kind, phase }) => [type, kind ?? phase ?? null]);

for (const [type, kind] of [['permission_prompt', 'permission'], ['idle_prompt', 'idle'], ['elicitation_dialog', 'question'], ['elicitation_url_dialog', 'question'], ['agent_needs_input', 'question']]) {
  test(`${type} queues waiting ${kind}`, async () => {
    const { fire, events } = setup();
    await fire('Notification', { notification_type: type });
    assert.deepEqual(shape(events()), [['waiting', kind]]);
  });
}

test('second notification in one stretch queues nothing', async () => {
  const { data, fire, events } = setup();
  await fire('Notification', { notification_type: 'permission_prompt' });
  await fire('Notification', { notification_type: 'idle_prompt' });
  assert.deepEqual(shape(events()), [['waiting', 'permission']]);
  assert.equal(loadRun(data, 's').waiting, true);
});

test('Resume after waiting queues resumed and a new stretch gets a new id', async () => {
  const { data, fire, events } = setup();
  await fire('Notification', { notification_type: 'permission_prompt' });
  await fire('Resume', { tool_name: 'Bash' });
  await fire('Notification', { notification_type: 'permission_prompt' });
  assert.deepEqual(shape(events()), [['waiting', 'permission'], ['resumed', null], ['waiting', 'permission']]);
  assert.equal(new Set(events().map((e) => e.id)).size, 3);
  assert.equal(loadRun(data, 's').waiting, true);
});

test('prompt submit queues turn started and resumed when waiting', async () => {
  const { data, fire, events } = setup();
  await fire('UserPromptSubmit', { prompt: 'go' });
  assert.deepEqual(shape(events()), [['turn', 'started']]);
  await fire('Notification', { notification_type: 'idle_prompt' });
  await fire('UserPromptSubmit', { prompt: 'again' });
  assert.deepEqual(shape(events()), [['turn', 'started'], ['waiting', 'idle'], ['resumed', null], ['turn', 'started']]);
  assert.equal(loadRun(data, 's').waiting, false);
  assert.equal(new Set(events().map((e) => e.id)).size, 4);
});

test('stop queues turn ended', async () => {
  const { fire, events } = setup();
  await fire('UserPromptSubmit', { prompt: 'go' });
  assert.deepEqual(await fire('Stop', { stop_hook_active: false }), {});
  assert.deepEqual(shape(events()), [['turn', 'started'], ['turn', 'ended']]);
  assert.ok(events().every((e) => e.id.length <= 64 && e.occurred_at));
});

test('stop ends a waiting stretch a denied prompt left open', async () => {
  const { data, fire, events } = setup();
  await fire('UserPromptSubmit', { prompt: 'go' });
  await fire('Notification', { notification_type: 'permission_prompt' });
  await fire('Stop', { stop_hook_active: false });
  await fire('Notification', { notification_type: 'idle_prompt' });
  assert.deepEqual(shape(events()), [['turn', 'started'], ['waiting', 'permission'], ['resumed', null], ['turn', 'ended'], ['waiting', 'idle']]);
  assert.equal(loadRun(data, 's').waiting, true);
});

test('Resume exits without queueing when not waiting, even with the lock held', async () => {
  const { data, fire, events } = setup();
  mkdirSync(join(data, '.lock'));
  const started = Date.now();
  assert.deepEqual(await fire('Resume', { tool_name: 'Read' }), {});
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(events(), []);
});

test('no signal for a run that never started or has ended', async () => {
  for (const run of [{ startedAt: undefined }, { ended: true }]) {
    const { fire, events } = setup(run);
    await fire('Notification', { notification_type: 'permission_prompt' });
    assert.deepEqual(events(), []);
  }
});

test('hook message text is never queued', async () => {
  const { data, fire } = setup();
  await fire('Notification', { notification_type: 'permission_prompt' });
  await fire('Resume', { tool_name: 'Bash' });
  await fire('UserPromptSubmit', { prompt: 'go' });
  assert.ok(!JSON.stringify(readOutbox(data)).includes('secret-path'));
});

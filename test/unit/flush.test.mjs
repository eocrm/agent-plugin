import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '../../lib/api.mjs';
import { enqueue, readOutbox } from '../../lib/outbox.mjs';
import { flush } from '../../lib/flush.mjs';
import { drain } from '../../lib/remind.mjs';
import { loadConventions } from '../../lib/reconcile.mjs';
import { loadRun, saveRun } from '../../lib/state.mjs';

const SID = 'sess-1';
const show = async (data) => (await drain({ data, now: () => Date.now() }, SID)).map((m) => m.id);
const beat = async (data, go) => {
  await enqueue(data, { kind: 'heartbeat', sessionId: SID });
  await go();
};
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const msg = (id, extra = {}) => ({ id, kind: 'task_comment', audience: 'member', text: `eocrm: ${id}`, ...extra });

function setup(t, replies) {
  const data = mkdtempSync(join(tmpdir(), 'eocrm-flush-unit-'));
  saveRun(data, SID, { runId: 'run-1', generation: 0 });
  const calls = [];
  const reply = (kind, ack) => {
    calls.push({ kind, ack });
    return replies.shift() ?? { status: 200, body: {} };
  };
  const client = {
    startRun: async () => reply('start'),
    updateRun: async () => reply('update'),
    heartbeat: async (id, ack) => reply('heartbeat', ack),
    recordEvents: async (id, events, ack) => reply('events', ack),
    conventions: async () => {
      calls.push({ kind: 'conventions' });
      return { status: 200, body: { plan_import: true } };
    },
  };
  const go = () => flush({ data, sessionId: SID, deadlineMs: 5000, clientFor: () => client });
  go.replies = replies;
  return { data, calls, client, go };
}

test('requests carry the plugin User-Agent', async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push(init.headers['user-agent']);
    return new Response(null, { status: 204 });
  };
  const endpoints = { issuer: 'https://id.example', key: 'k', api: (w) => `https://${w}.example/api` };
  const store = { get: async () => ({ access_token: 'a' }) };
  await createClient({ endpoints, workspace: 'acme', store, fetch }).heartbeat('r');
  await createClient({ endpoints, workspace: 'acme', store, fetch, harness: 'codex' }).heartbeat('r');
  assert.deepEqual(seen, [`eocrm-plugin/${version} (claude-code)`, `eocrm-plugin/${version} (codex)`]);
});

test('reply messages are stored, invalid ones skipped, acks sent once', async (t) => {
  const { data, calls, go } = setup(t, [
    { status: 200, body: { accepted: 1, duplicates: 0, dropped: 0, messages: [msg('m1'), msg('m2', { audience: 'agent' }), { id: 'bad' }] } },
  ]);
  await enqueue(data, { kind: 'event', sessionId: SID, event: { id: 'commit:1', type: 'commit', sha: 'abc1234', subject: 's' } });
  await go();
  assert.deepEqual(loadRun(data, SID).inbox.map((m) => m.id), ['m1', 'm2']);
  assert.deepEqual(await show(data), ['m1', 'm2']);
  await beat(data, go);
  await beat(data, go);
  assert.deepEqual(calls.map((c) => [c.kind, c.ack]), [['events', []], ['heartbeat', ['m1', 'm2']], ['heartbeat', []]]);
  assert.deepEqual(loadRun(data, SID).inbox, []);
});

test('a 426 keeps the outbox and pauses until the version changes', async (t) => {
  const { data, calls, go } = setup(t, [
    { status: 426, body: { code: 'plugin_outdated', message: 'Update.', minimum: '9.0.0', latest: '9.1.0', update: '/plugin marketplace update eocrm' } },
  ]);
  await enqueue(data, { kind: 'event', sessionId: SID, event: { id: 'commit:1', type: 'commit', sha: 'abc1234', subject: 's' } });
  const result = await go();
  assert.deepEqual(result.rejected, []);
  assert.equal(readOutbox(data).length, 1);
  const { outdated } = loadRun(data, SID);
  assert.deepEqual({ ...outdated, at: typeof outdated.at }, { minimum: '9.0.0', latest: '9.1.0', at: 'number', version });
  await go();
  assert.equal(calls.length, 1);
  saveRun(data, SID, { outdated: { ...outdated, version: '0.0.0' } });
  await go();
  assert.equal(calls.length, 2);
  assert.deepEqual(readOutbox(data), []);
});

test('a conventions notice forces a reload', async (t) => {
  const { data, calls, client, go } = setup(t, [
    { status: 200, body: { messages: [msg('n1', { kind: 'notice', text: 'eocrm: Agent work conventions changed.', data: { reload: 'conventions' } })] } },
  ]);
  saveRun(data, SID, { conventions: { plan_import: false }, conventionsAt: Date.now() });
  await enqueue(data, { kind: 'heartbeat', sessionId: SID });
  await go();
  const run = loadRun(data, SID);
  assert.deepEqual(await loadConventions({}, run, client), { plan_import: true });
  assert.equal(calls.at(-1).kind, 'conventions');
});

test('a re-sent message is acked again but shown once', async (t) => {
  const { data, calls, go } = setup(t, [
    { status: 200, body: { messages: [msg('m1')] } },
    { status: 200, body: { messages: [msg('m1')] } },
    { status: 200, body: { messages: [msg('m1')] } },
  ]);
  await beat(data, go);
  await beat(data, go);
  assert.deepEqual(await show(data), ['m1']);
  await beat(data, go);
  await beat(data, go);
  assert.deepEqual(calls.map((c) => c.ack), [[], [], ['m1'], ['m1']]);
  assert.deepEqual(loadRun(data, SID).inbox, []);
});

test('a message is acked only after it is shown', async (t) => {
  const { data, calls, go } = setup(t, [{ status: 200, body: { messages: [msg('m1')] } }]);
  await beat(data, go);
  await beat(data, go);
  assert.deepEqual(loadRun(data, SID).ackPending, []);
  await show(data);
  await beat(data, go);
  assert.deepEqual(calls.map((c) => c.ack), [[], [], ['m1']]);
});

test('an oversized reply is capped', async (t) => {
  const big = msg('x'.repeat(100), { text: 'y'.repeat(2000), data: { reload: 'conventions', extra: 'z' } });
  const many = Array.from({ length: 24 }, (_, i) => msg(`m${i}`));
  const { data, go } = setup(t, [{ status: 200, body: { messages: [big, ...many] } }]);
  saveRun(data, SID, { ackPending: Array.from({ length: 95 }, (_, i) => `old${i}`) });
  await enqueue(data, { kind: 'step', sessionId: SID, step: 'Task 1' });
  await go();
  const { inbox, ackPending } = loadRun(data, SID);
  assert.equal(inbox.length, 20);
  assert.deepEqual([inbox[0].id.length, inbox[0].text.length, inbox[0].data], [64, 1000, { reload: 'conventions' }]);
  assert.equal(ackPending.length, 95);
  assert.deepEqual([ackPending[0], ackPending.at(-1)], ['old0', 'old94']);
});

test('inbox overflow stays unacked until shown, then every message is shown once', async (t) => {
  const id = (i) => `b${Math.floor(i / 20)}m${i % 20}`;
  const all = Array.from({ length: 80 }, (_, i) => id(i));
  const reply = (ids) => ({ status: 200, body: { messages: ids.map((x) => msg(x)) } });
  const { data, calls, go } = setup(t, [0, 1, 2, 3].map((b) => reply(all.slice(b * 20, b * 20 + 20))));
  for (let i = 0; i < 4; i++) await beat(data, go);
  assert.ok(calls.every((c) => c.ack.length === 0));
  const inbox = loadRun(data, SID).inbox.map((m) => m.id);
  assert.equal(inbox.length, 50);
  const shown = await show(data);
  assert.deepEqual(shown, inbox);
  const evicted = all.filter((x) => !inbox.includes(x));
  assert.equal(evicted.length, 30);
  calls.length = 0;
  go.replies.push(reply(evicted.slice(0, 20)), reply(evicted.slice(20)));
  await beat(data, go);
  assert.deepEqual(calls[0].ack, inbox);
  await beat(data, go);
  shown.push(...await show(data));
  assert.deepEqual(calls[1].ack, []);
  assert.deepEqual([...shown].sort(), [...all].sort());
});

test('a message with an unknown kind or audience is dropped', async (t) => {
  const { data, go } = setup(t, [{ status: 200, body: { messages: [msg('ok'), msg('k', { kind: 'bogus' }), msg('a', { audience: 'nobody' })] } }]);
  await enqueue(data, { kind: 'heartbeat', sessionId: SID });
  await go();
  assert.deepEqual(loadRun(data, SID).inbox.map((m) => m.id), ['ok']);
});

test('a 426 with an empty body still pauses and keeps the outbox', async (t) => {
  const { data, calls, go } = setup(t, [{ status: 426, body: null }]);
  await enqueue(data, { kind: 'event', sessionId: SID, event: { id: 'commit:1', type: 'commit', sha: 'abc1234', subject: 's' } });
  await go();
  await go();
  assert.equal(calls.length, 1);
  assert.equal(readOutbox(data).length, 1);
  assert.deepEqual([loadRun(data, SID).outdated.minimum, loadRun(data, SID).outdated.version], [null, version]);
});

test('a task_unfinished message keeps its key and status', async (t) => {
  const m = msg('u1', { kind: 'task_unfinished', audience: 'agent', data: { key: 'EO-1', status: 'In progress', extra: 'x' } });
  const { data, go } = setup(t, [{ status: 200, body: { messages: [m] } }]);
  await beat(data, go);
  assert.deepEqual(loadRun(data, SID).inbox, [{ id: 'u1', kind: 'task_unfinished', audience: 'agent', text: 'eocrm: u1', data: { key: 'EO-1', status: 'In progress' } }]);
});

test('a task_unfinished status over 40 characters is kept empty, not cut', async (t) => {
  const m = msg('u1', { kind: 'task_unfinished', audience: 'agent', data: { key: 'EO-1', status: 'a'.repeat(41) } });
  const { data, go } = setup(t, [{ status: 200, body: { messages: [m] } }]);
  await beat(data, go);
  assert.equal(loadRun(data, SID).inbox[0].data.status, '');
});

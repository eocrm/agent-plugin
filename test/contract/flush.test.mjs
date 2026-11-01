import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { endpoints } from '../../lib/endpoints.mjs';
import { createClient } from '../../lib/api.mjs';
import { enqueue, readOutbox } from '../../lib/outbox.mjs';
import { flush } from '../../lib/flush.mjs';
import { loadRun, saveRun } from '../../lib/state.mjs';
import { startFixtureServer } from '../support/fixture-server.mjs';

const SID = 'sess-1';
const ev = (n, extra = {}) => ({ kind: 'event', sessionId: SID, event: { id: `commit:${n}`, type: 'commit', occurred_at: '2026-11-01T00:00:00Z', sha: `abc123${n}`, subject: `c${n}`, ...extra } });

async function setup(t, responses) {
  const server = await startFixtureServer({ responses });
  t.after(() => server.close());
  const data = realpathSync.native(mkdtempSync(join(tmpdir(), 'eocrm-flush-')));
  let tokens = { access_token: server.auth.access, refresh_token: server.auth.refresh, client_id: server.auth.clientId };
  const store = { get: async () => tokens, update: async (key, fn) => (tokens = (await fn(tokens)) ?? tokens) };
  const replies = [];
  const clientFor = () => {
    const client = createClient({ endpoints: endpoints({ region: 'eu', env: server.endpointsEnv }), workspace: 'acme', store });
    return { ...client, recordEvents: async (...args) => { const r = await client.recordEvents(...args); replies.push(r); return r; } };
  };
  const go = () => flush({ data, sessionId: SID, deadlineMs: 5000, clientFor });
  const calls = () => server.requests.map((r) => `${r.method} ${r.path.replace(/01JZRUN\d+/, ':id')}`);
  return { server, data, go, replies, calls, clientFor };
}

test('start, events in batches of 100, step, heartbeat, finish', async (t) => {
  const { server, data, go, calls } = await setup(t);
  saveRun(data, SID, { start: { branch: 'feat/AB-12-x', repo: 'o/r' } });
  await enqueue(data, { kind: 'finish', sessionId: SID });
  await enqueue(data, { kind: 'heartbeat', sessionId: SID });
  await enqueue(data, { kind: 'step', sessionId: SID, step: 'Task 1' });
  for (let i = 0; i < 150; i++) await enqueue(data, ev(i));
  await enqueue(data, { kind: 'start', sessionId: SID });
  const result = await go();
  assert.deepEqual(result, { sent: 154, rejected: [], retryable: false, signedOut: false });
  assert.deepEqual(calls(), ['POST /v1/agent-runs', 'POST /v1/agent-runs/:id/events', 'POST /v1/agent-runs/:id/events', 'PATCH /v1/agent-runs/:id', 'POST /v1/agent-runs/:id/heartbeat', 'PATCH /v1/agent-runs/:id']);
  assert.deepEqual(server.requests[0].body, { branch: 'feat/AB-12-x', repo: 'o/r', client_run_id: SID });
  assert.deepEqual(server.requests.slice(1, 3).map((r) => r.body.events.length), [100, 50]);
  assert.deepEqual(server.requests.slice(3).map((r) => r.body), [{ step: 'Task 1' }, undefined, { state: 'finished' }]);
  assert.deepEqual(readOutbox(data), []);
  assert.equal(Object.keys(loadRun(data, SID).acked).length, 150);
});

test('flushing twice sends the same event ids; the second is all duplicates', async (t) => {
  const { server, data, go, replies } = await setup(t);
  const n = 3;
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < n; i++) await enqueue(data, ev(i));
    assert.equal((await go()).sent, n);
  }
  const sent = server.requests.filter((r) => r.path.endsWith('/events')).map((r) => r.body.events.map((e) => e.id));
  assert.deepEqual(sent[0], sent[1]);
  assert.deepEqual(replies.map((r) => r.body.duplicates), [0, n]);
});

test('a batch never mixes plan sources', async (t) => {
  const { server, data, go } = await setup(t);
  const planEv = (id, source) => ({ kind: 'event', sessionId: SID, event: { id, type: 'plan', source, items: [{ key: 'k', text: 't' }] } });
  await enqueue(data, planEv('plan:a', 'todo'));
  await enqueue(data, ev(1));
  await enqueue(data, planEv('plan:b', 'todo'));
  await enqueue(data, planEv('plan:c', 'markdown'));
  await go();
  const batches = server.requests.filter((r) => r.path.endsWith('/events')).map((r) => r.body.events.map((e) => e.id));
  assert.deepEqual(batches, [['plan:a', 'commit:1', 'plan:b'], ['plan:c']]);
});

test('a 422 on events.1.url rejects only entry 1', async (t) => {
  const { server, data, go } = await setup(t);
  await enqueue(data, ev(0));
  await enqueue(data, { kind: 'event', sessionId: SID, event: { id: 'pull_request:x', type: 'pull_request', action: 'opened', url: 'not a url' } });
  await enqueue(data, ev(2));
  const result = await go();
  assert.deepEqual(result.rejected.map((r) => [r.eventId, r.type, r.label, r.status]), [['pull_request:x', 'pull_request', 'not a url', 422]]);
  assert.match(result.rejected[0].message, /uri/);
  const batches = server.requests.filter((r) => r.path.endsWith('/events')).map((r) => r.body.events.map((e) => e.id));
  assert.deepEqual(batches, [['commit:0', 'pull_request:x', 'commit:2'], ['commit:0', 'commit:2']]);
  assert.deepEqual(readOutbox(data), []);
  assert.deepEqual(loadRun(data, SID).rejected.map((r) => r.eventId), ['pull_request:x']);
  assert.deepEqual(readFileSync(join(data, 'rejected.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).eventId), ['pull_request:x']);
});

test('any other 422 rejects the whole batch', async (t) => {
  const { data, go } = await setup(t, { 'agentRun.events.store': { status: 422, body: { message: 'Bad.', errors: { events: ['too many'], 'events.0.sha': ['bad sha'] } } } });
  await enqueue(data, ev(0));
  await enqueue(data, ev(1));
  const result = await go();
  assert.deepEqual(result.rejected.map((r) => [r.eventId, r.message]), [['commit:0', 'Bad.'], ['commit:1', 'Bad.']]);
  assert.equal(result.retryable, false);
  assert.deepEqual(readOutbox(data), []);
});

test('a 409 run_ended rolls to generation 1 and keeps the events', async (t) => {
  let ended = true;
  const { server, data, go } = await setup(t, {
    'agentRun.events.store': () => (ended ? ((ended = false), { status: 409, body: { code: 'run_ended', message: 'This run has already ended.' } }) : undefined),
  });
  await enqueue(data, ev(0));
  const result = await go();
  assert.deepEqual(result, { sent: 1, rejected: [], retryable: false, signedOut: false });
  const starts = server.requests.filter((r) => r.path === '/v1/agent-runs').map((r) => r.body.client_run_id);
  assert.deepEqual(starts, [SID, `${SID}.1`]);
  const run = loadRun(data, SID);
  assert.deepEqual([run.generation, run.clientRunId], [1, `${SID}.1`]);
  assert.equal(server.requests.filter((r) => r.path.endsWith('/events')).at(-1).body.events[0].id, 'commit:0');
});

test('a 409 on finish means the run is already over', async (t) => {
  const { data, go } = await setup(t, { 'agentRun.update': { status: 409, body: { code: 'run_ended', message: 'ended' } } });
  await enqueue(data, { kind: 'finish', sessionId: SID });
  assert.deepEqual(await go(), { sent: 1, rejected: [], retryable: false, signedOut: false });
  assert.equal(loadRun(data, SID).generation, 0);
});

test('a 503 keeps every entry and is retryable', async (t) => {
  const { data, go } = await setup(t, { 'agentRun.events.store': { status: 503, body: { message: 'down' } } });
  await enqueue(data, ev(0));
  await enqueue(data, ev(1));
  const result = await go();
  assert.equal(result.retryable, true);
  assert.deepEqual(readOutbox(data).map((e) => e.event.id), ['commit:0', 'commit:1']);
});

test('a 401 keeps every entry and signs out', async (t) => {
  const { data, go } = await setup(t, { 'agentRun.store': { status: 401, body: { message: 'Unauthenticated.' } } });
  await enqueue(data, ev(0));
  const result = await go();
  assert.deepEqual([result.signedOut, result.sent], [true, 0]);
  assert.equal(readOutbox(data).length, 1);
});

test('a network failure keeps every entry and is retryable', async (t) => {
  const { data } = await setup(t);
  await enqueue(data, ev(0));
  const dead = { ...endpoints({ region: 'eu', env: { EOCRM_ENDPOINTS: JSON.stringify({ issuer: 'http://127.0.0.1:9', api: 'http://127.0.0.1:9/{workspace}/api' }) } }) };
  const store = { get: async () => ({ access_token: 'x' }) };
  const result = await flush({ data, sessionId: SID, deadlineMs: 5000, clientFor: () => createClient({ endpoints: dead, workspace: 'acme', store }) });
  assert.deepEqual([result.retryable, result.sent], [true, 0]);
  assert.equal(readOutbox(data).length, 1);
});

test('a past deadline sends nothing and is retryable', async (t) => {
  const { data, server, clientFor } = await setup(t);
  await enqueue(data, ev(0));
  const result = await flush({ data, sessionId: SID, deadlineMs: 0, clientFor });
  assert.deepEqual([result.retryable, server.requests.length], [true, 0]);
});

test('a flush already running elsewhere makes this one a retryable no-op', async (t) => {
  const { data, go, server } = await setup(t);
  await enqueue(data, ev(0));
  const { withLock } = await import('../../lib/state.mjs');
  const began = Date.now();
  const result = await withLock(join(data, 'flush'), go);
  assert.deepEqual([result.retryable, server.requests.length], [true, 0]);
  assert.ok(Date.now() - began < 1000);
});

test('a run that keeps answering 409 rolls once per flush, then retries later', async (t) => {
  const { server, data, go } = await setup(t, { 'agentRun.events.store': { status: 409, body: { code: 'run_ended', message: 'ended' } } });
  await enqueue(data, ev(0));
  assert.equal((await go()).retryable, true);
  assert.deepEqual(server.requests.filter((r) => r.path === '/v1/agent-runs').map((r) => r.body.client_run_id), [SID, `${SID}.1`]);
  assert.equal(readOutbox(data).length, 1);
});

test('a 404 on start rejects it instead of rolling', async (t) => {
  const { server, data, go } = await setup(t, { 'agentRun.store': { status: 404, body: { message: 'Not Found' } } });
  await enqueue(data, { kind: 'start', sessionId: SID });
  await enqueue(data, ev(0));
  const result = await go();
  assert.deepEqual(result.rejected.map((r) => [r.type, r.status]), [['start', 404]]);
  assert.equal(server.requests.length, 1);
  assert.equal(loadRun(data, SID).generation ?? 0, 0);
  assert.deepEqual(readOutbox(data).map((e) => e.kind), ['event']);
});

test('an off-contract reply ends the session pass instead of looping', async () => {
  const data = realpathSync.native(mkdtempSync(join(tmpdir(), 'eocrm-flush-')));
  let calls = 0;
  const reply = (r) => async () => ((calls += 1), r);
  await enqueue(data, ev(0));
  const noId = await flush({ data, sessionId: SID, deadlineMs: 5000, clientFor: () => ({ startRun: reply({ status: 200, body: {} }) }) });
  assert.deepEqual([noId.sent, calls], [0, 1]);
  calls = 0;
  saveRun(data, SID, { runId: 'r1' });
  const stray = await flush({ data, sessionId: SID, deadlineMs: 5000, clientFor: () => ({ recordEvents: reply({ status: 422, body: { message: 'x', errors: { 'events.9.url': ['bad'] } } }) }) });
  assert.deepEqual([stray.rejected, calls, readOutbox(data).length], [[], 1, 1]);
});

test('a 401 stops the whole flush, not just one session', async (t) => {
  const { server, data, clientFor } = await setup(t, { 'agentRun.store': { status: 401, body: { message: 'Unauthenticated.' } } });
  await enqueue(data, ev(0));
  await enqueue(data, { ...ev(0), sessionId: 'sess-2' });
  const result = await flush({ data, deadlineMs: 5000, clientFor });
  assert.equal(result.signedOut, true);
  assert.deepEqual(server.requests.filter((r) => r.path === '/v1/agent-runs').map((r) => r.body.client_run_id), [SID, SID]);
});

test('one broken session does not hold back the others', async (t) => {
  const { server, data, clientFor } = await setup(t);
  await enqueue(data, { ...ev(0), sessionId: '../bad' });
  await enqueue(data, ev(1));
  const result = await flush({ data, deadlineMs: 5000, clientFor });
  assert.deepEqual([result.sent, result.retryable], [1, true]);
  assert.equal(server.requests.filter((r) => r.path.endsWith('/events')).length, 1);
});

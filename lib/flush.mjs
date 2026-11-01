import { join } from 'node:path';
import { withLock, loadRun, saveRun } from './state.mjs';
import { readOutbox, rewrite } from './outbox.mjs';

const BATCH = 100;
const KEEP_REJECTED = 50;
const EVENT_KEY = /^events\.(\d+)(?:\.|$)/;

export const clientRunId = (sessionId, generation) => (generation ? `${sessionId}.${generation}` : sessionId);

function classify(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401) return 'signedOut';
  if (status === 404 || status === 409) return 'roll';
  if (status === 400 || status === 403 || status === 422) return 'reject';
  return 'retry';
}

function nextBatch(events) {
  const batch = [];
  let source;
  for (const entry of events) {
    if (batch.length === BATCH) break;
    if (entry.event.type === 'plan') {
      if (source !== undefined && entry.event.source !== source) break;
      source = entry.event.source;
    }
    batch.push(entry);
  }
  return batch;
}

function rejection(entry, status, body, message) {
  const e = entry.event ?? {};
  return {
    eventId: e.id ?? null,
    type: e.type ?? entry.kind,
    label: e.label ?? e.subject ?? e.command ?? e.url ?? e.what ?? e.summary ?? entry.step ?? entry.kind,
    status,
    ...(typeof body?.code === 'string' ? { code: body.code } : {}),
    message: message ?? (typeof body?.message === 'string' ? body.message : `HTTP ${status}`),
  };
}

function plan(pending, run) {
  const starts = pending.filter((e) => e.kind === 'start');
  if (!run.runId || starts.length) return { kind: 'start', entries: starts };
  const events = pending.filter((e) => e.kind === 'event');
  if (events.length) return { kind: 'event', entries: nextBatch(events) };
  for (const kind of ['task', 'step', 'heartbeat', 'finish']) {
    const entries = pending.filter((e) => e.kind === kind);
    if (entries.length) return { kind, entries };
  }
  return null;
}

function send(client, run, sessionId, { kind, entries }) {
  if (kind === 'start') return client.startRun({ ...run.start, client_run_id: clientRunId(sessionId, run.generation ?? 0) });
  if (kind === 'event') return client.recordEvents(run.runId, entries.map((e) => e.event));
  if (kind === 'task') return client.updateRun(run.runId, { task: entries.at(-1).task });
  if (kind === 'step') return client.updateRun(run.runId, { step: entries.at(-1).step });
  if (kind === 'heartbeat') return client.heartbeat(run.runId);
  return client.updateRun(run.runId, { state: 'finished' });
}

function rejectedEntries(action, status, body) {
  const keys = Object.keys(body?.errors ?? {});
  const indexed = action.kind === 'event' && status === 422 && keys.length > 0 && keys.every((k) => EVENT_KEY.test(k));
  if (!indexed) return action.entries.map((entry) => [entry, null]);
  const messages = new Map();
  for (const k of keys) {
    const i = Number(EVENT_KEY.exec(k)[1]);
    messages.set(i, [...(messages.get(i) ?? []), ...body.errors[k]]);
  }
  const hit = [...messages].filter(([i]) => action.entries[i]).map(([i, m]) => [action.entries[i], m.join(' ')]);
  return hit.length ? hit : action.entries.map((entry) => [entry, null]);
}

async function settle(data, sessionId, { removed = [], acked = [], rejected = [], patch = {} }) {
  await withLock(data, async () => {
    const gone = new Set(removed.map((e) => e.seq));
    rewrite(data, (entries) => entries.filter((e) => !gone.has(e.seq)));
    const run = loadRun(data, sessionId);
    saveRun(data, sessionId, {
      ...patch,
      acked: { ...run.acked, ...Object.fromEntries(acked.map((id) => [id, true])) },
      rejected: [...run.rejected, ...rejected].slice(-KEEP_REJECTED),
    });
  });
}

async function flushSession(data, sessionId, clientFor, end, result) {
  let rolled = false;
  for (;;) {
    const pending = readOutbox(data).filter((e) => e.sessionId === sessionId);
    if (!pending.length) return;
    if (Date.now() >= end) {
      result.retryable = true;
      return;
    }
    const run = loadRun(data, sessionId);
    const action = plan(pending, run);
    const { status, body } = await send(clientFor(run), run, sessionId, action);
    let outcome = classify(status);
    if (outcome === 'roll' && action.kind === 'start') outcome = 'reject';
    else if (outcome === 'roll' && action.kind !== 'event') outcome = 'drop';

    if (outcome === 'drop') {
      await settle(data, sessionId, { removed: action.entries });
    } else if (outcome === 'ok') {
      const acked = action.kind === 'event' ? action.entries.map((e) => e.event.id) : [];
      const patch = action.kind === 'start' ? { runId: body?.id, generation: run.generation ?? 0, clientRunId: clientRunId(sessionId, run.generation ?? 0) } : {};
      await settle(data, sessionId, { removed: action.entries, acked, patch });
      result.sent += action.entries.length;
      if (action.kind === 'start' && typeof body?.id !== 'string') return;
    } else if (outcome === 'reject') {
      const rejected = rejectedEntries(action, status, body);
      const records = (rejected.length ? rejected : [[{ kind: action.kind }, null]]).map(([entry, message]) => rejection(entry, status, body, message));
      await settle(data, sessionId, { removed: rejected.map(([entry]) => entry), rejected: records });
      result.rejected.push(...records);
      if (action.kind === 'start') return;
    } else if (outcome === 'roll' && !rolled) {
      rolled = true;
      const generation = (run.generation ?? 0) + 1;
      await settle(data, sessionId, { patch: { generation, runId: null, clientRunId: clientRunId(sessionId, generation) } });
    } else {
      if (outcome === 'signedOut') result.signedOut = true;
      else result.retryable = true;
      return;
    }
  }
}

export async function flush({ data, sessionId, deadlineMs = 20000, clientFor }) {
  const result = { sent: 0, rejected: [], retryable: false, signedOut: false };
  const end = Date.now() + deadlineMs;
  try {
    await withLock(join(data, 'flush'), async () => {
      await withLock(data, async () => rewrite(data, (entries) => entries)).catch(() => {});
      const sessions = sessionId ? [sessionId] : [...new Set(readOutbox(data).map((e) => e.sessionId))];
      for (const sid of sessions) {
        try {
          await flushSession(data, sid, clientFor, end, result);
        } catch {
          result.retryable = true;
        }
        if (result.signedOut) return;
      }
    }, { giveUpMs: 0 });
  } catch {
    result.retryable = true;
  }
  return result;
}

import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { withLock, loadRun, saveRun } from './state.mjs';
import { readOutbox, rewrite } from './outbox.mjs';
import { logError } from './run.mjs';
import { VERSION } from './api.mjs';

const BATCH = 100;
const EXTRA_PASSES = 3;
const KEEP_REJECTED = 50;
const KEEP_FINGERPRINTS = 500;
const KEEP_MESSAGES = 50;
const KEEP_MESSAGE_IDS = 500;
export const KEEP_ACKS = 100;
const MAX_MESSAGES = 20;
const KINDS = new Set(['plugin_update', 'task_comment', 'notice']);
const AUDIENCES = new Set(['member', 'agent']);
const EVENT_KEY = /^events\.(\d+)(?:\.(.+))?$/;
const GIVE_UP_MS = 5000;
const lockFor = (end) => ({ giveUpMs: Math.max(0, Math.min(GIVE_UP_MS, end - Date.now())) });
// A server older than the plugin refuses these; they must never block the stop gate.
const SIGNALS = new Set(['waiting', 'resumed', 'turn']);
const isTick = (e) => e.kind === 'event' && e.event?.type === 'step' && e.event.plan_key != null;

const local = (id, text) => ({ id: `local:${id}`, kind: 'notice', audience: 'member', text });
const OFF = local('module_disabled', 'eocrm: Agent work is off for this workspace.');
const SIGNED_OUT = local('signed_out', 'eocrm: you\'re signed out of eocrm; run /eocrm:login.');
const outdatedNotice = (minimum) => local(`outdated:${VERSION}`, `eocrm: plugin ${VERSION} is below the minimum ${String(minimum ?? 'version').slice(0, 40)}, so tracking is paused. Run /plugin marketplace update eocrm.`);

export const fingerprint = (r) => createHash('sha256').update(JSON.stringify([r.type, r.eventId ?? null, r.status, r.code ?? null, r.message])).digest('base64url').slice(0, 22);

export const clientRunId = (sessionId, generation) => (generation ? `${sessionId}.${generation}` : sessionId);

function classify(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401) return 'signedOut';
  if (status === 404 || status === 409) return 'roll';
  if (status === 400 || status === 403 || status === 422) return 'reject';
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return 'refuse';
  return 'retry';
}

function nextBatch(events) {
  const batch = [];
  for (const entry of events) {
    if (batch.length === BATCH) break;
    // The server ticks against a batch's latest plan, so each plan opens its own batch.
    if (entry.event.type === 'plan' && batch.length) break;
    batch.push(entry);
  }
  return batch;
}

function rejection(entry, status, body, message, fields) {
  const e = entry.event ?? {};
  return {
    ...(fields?.length ? { fields } : {}),
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

const messagesOf = (body) => (Array.isArray(body?.messages) ? body.messages.slice(0, MAX_MESSAGES) : [])
  .filter((m) => typeof m?.id === 'string' && KINDS.has(m.kind) && AUDIENCES.has(m.audience) && typeof m.text === 'string')
  .map((m) => ({
    id: m.id.slice(0, 64),
    kind: m.kind,
    audience: m.audience,
    text: m.text.slice(0, 1000),
    ...(typeof m.data?.reload === 'string' ? { data: { reload: m.data.reload } } : {}),
  }));

function send(client, run, sessionId, { kind, entries }, ack) {
  if (kind === 'start') return client.startRun({ ...run.start, client_run_id: clientRunId(sessionId, run.generation ?? 0) });
  if (kind === 'event') return client.recordEvents(run.runId, entries.map((e) => e.event), ack);
  if (kind === 'task') return client.updateRun(run.runId, { task: entries.at(-1).task });
  if (kind === 'step') return client.updateRun(run.runId, { step: entries.at(-1).step });
  if (kind === 'heartbeat') return client.heartbeat(run.runId, ack);
  return client.updateRun(run.runId, { state: 'finished' });
}

function rejectedEntries(action, status, body) {
  const keys = Object.keys(body?.errors ?? {});
  const indexed = action.kind === 'event' && status === 422 && keys.length > 0 && keys.every((k) => EVENT_KEY.test(k));
  if (!indexed) return action.entries.map((entry) => [entry, null, []]);
  const byIndex = new Map();
  for (const k of keys) {
    const [, i, field] = EVENT_KEY.exec(k);
    const hit = byIndex.get(Number(i)) ?? { messages: [], fields: [] };
    hit.messages.push(...body.errors[k]);
    if (field) hit.fields.push(field);
    byIndex.set(Number(i), hit);
  }
  const hit = [...byIndex].filter(([i]) => action.entries[i]).map(([i, h]) => [action.entries[i], h.messages.join(' '), h.fields]);
  return hit.length ? hit : action.entries.map((entry) => [entry, null, []]);
}

// A rejected plan's ticks, up to the next plan, go unsent and unrecorded: alone they would tick the previous plan.
function orphanedTicks(pending, rejected) {
  const gone = new Set(rejected.map(([entry]) => entry));
  const out = [];
  let orphan = false;
  for (const entry of pending) {
    if (entry.kind === 'event' && entry.event?.type === 'plan') orphan = gone.has(entry);
    else if (orphan && isTick(entry) && !gone.has(entry)) out.push(entry);
  }
  return out;
}

async function settle(data, sessionId, { removed = [], acked = [], rejected = [], patch = {}, messages = [], ackSent = [], notices = [] }, end) {
  await withLock(data, async () => {
    const gone = new Set(removed.map((e) => e.seq));
    rewrite(data, (entries) => entries.filter((e) => !gone.has(e.seq)));
    const run = loadRun(data, sessionId);
    const seen = new Set(run.rejectedFingerprints ?? run.rejected.map(fingerprint));
    const fresh = rejected.filter((r) => {
      const fp = fingerprint(r);
      return !seen.has(fp) && seen.add(fp);
    });
    const known = new Set(run.messageIds ?? []);
    const arrived = [...messages, ...notices].filter((m) => !known.has(m.id) && known.add(m.id));
    const sent = new Set(ackSent);
    if (arrived.some((m) => m.kind === 'notice' && m.data?.reload === 'conventions')) patch = { ...patch, conventionsAt: null };
    if (messages.length || ackSent.length || notices.length) {
      const all = [...(run.inbox ?? []), ...arrived];
      const inbox = all.slice(-KEEP_MESSAGES);
      const evicted = new Set(all.slice(0, -KEEP_MESSAGES).map((m) => m.id));
      const kept = new Set(inbox.map((m) => m.id));
      const shown = messages.filter((m) => (run.messageIds ?? []).includes(m.id) && !kept.has(m.id) && !evicted.has(m.id));
      for (const id of evicted) known.delete(id);
      patch = {
        ...patch,
        inbox,
        messageIds: [...known].slice(-KEEP_MESSAGE_IDS),
        ackPending: [...new Set([...(run.ackPending ?? []).filter((id) => !sent.has(id)), ...shown.map((m) => m.id)])].slice(-KEEP_ACKS),
      };
    }
    saveRun(data, sessionId, {
      ...patch,
      acked: { ...(patch.acked ?? run.acked), ...Object.fromEntries(acked.map((id) => [id, true])) },
      rejected: [...run.rejected, ...fresh].slice(-KEEP_REJECTED),
      rejectedFingerprints: [...seen].slice(-KEEP_FINGERPRINTS),
    });
  }, lockFor(end));
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
    if (!run.runId && run.startBlocked) return;
    if (run.outdated?.version === VERSION) return;
    const action = plan(pending, run);
    const ack = action.kind === 'event' || action.kind === 'heartbeat' ? run.ackPending ?? [] : [];
    const { status, body } = await send(clientFor(run), run, sessionId, action, ack);
    if (status === 426) {
      await settle(data, sessionId, { patch: { outdated: { minimum: body?.minimum ?? null, latest: body?.latest ?? null, at: Date.now(), version: VERSION } }, notices: [outdatedNotice(body?.minimum)] }, end);
      return;
    }
    let outcome = classify(status);
    if (outcome === 'roll' && action.kind === 'start') outcome = 'reject';
    else if (outcome === 'roll' && action.kind !== 'event') outcome = 'drop';

    const ended = action.kind === 'finish' ? { ended: true } : {};
    if (outcome === 'drop') {
      await settle(data, sessionId, { removed: action.entries, patch: ended }, end);
    } else if (outcome === 'ok') {
      const acked = action.kind === 'event' ? action.entries.map((e) => e.event.id) : [];
      const patch = action.kind === 'start' ? { runId: body?.id, generation: run.generation ?? 0, clientRunId: clientRunId(sessionId, run.generation ?? 0) } : {};
      await settle(data, sessionId, { removed: action.entries, acked, patch: { ...patch, ...ended }, messages: messagesOf(body), ackSent: ack }, end);
      result.sent += action.entries.length;
      if (action.kind === 'start' && typeof body?.id !== 'string') return;
    } else if (outcome === 'reject' || outcome === 'refuse') {
      const rejected = rejectedEntries(action, status, body);
      const orphans = action.kind === 'event' ? orphanedTicks(pending, rejected) : [];
      const all = (rejected.length ? rejected : [[{ kind: action.kind }, null, []]]).map(([entry, message, fields]) => rejection(entry, status, body, message, fields));
      const records = all.filter((r) => !SIGNALS.has(r.type));
      if (records.length < all.length) logError(data, `eocrm: dropped ${all.length - records.length} refused signal event(s) (HTTP ${status})`);
      const patch = action.kind === 'start' && outcome === 'reject' ? { startBlocked: fingerprint(records[0]) } : ended;
      await settle(data, sessionId, { removed: [...rejected.map(([entry]) => entry), ...orphans], rejected: records, patch, notices: body?.code === 'module_disabled' ? [OFF] : [] }, end);
      result.rejected.push(...records);
      if (action.kind === 'start') return;
    } else if (outcome === 'roll' && !rolled) {
      rolled = true;
      const generation = (run.generation ?? 0) + 1;
      await settle(data, sessionId, { patch: { generation, runId: null, clientRunId: clientRunId(sessionId, generation), acked: {}, serverEventsRead: false } }, end);
    } else {
      if (outcome !== 'signedOut') result.retryable = true;
      else {
        result.signedOut = true;
        await settle(data, sessionId, { notices: [SIGNED_OUT] }, end);
      }
      return;
    }
  }
}

export async function flush({ data, sessionId, deadlineMs = 20000, lockWaitMs = 0, clientFor }) {
  const result = { sent: 0, rejected: [], retryable: false, signedOut: false };
  const end = Date.now() + deadlineMs;
  try {
    await withLock(join(data, 'flush'), async () => {
      for (let pass = 0; pass <= EXTRA_PASSES; pass++) {
        await withLock(data, async () => rewrite(data, (entries) => entries), lockFor(end)).catch(() => {});
        const before = readOutbox(data);
        const seen = new Set(before.map((e) => e.seq));
        const sessions = sessionId ? [sessionId] : [...new Set(before.map((e) => e.sessionId))];
        for (const sid of sessions) {
          try {
            await flushSession(data, sid, clientFor, end, result);
          } catch {
            result.retryable = true;
          }
          if (result.signedOut) return;
        }
        const arrived = readOutbox(data).some((e) => !seen.has(e.seq) && (!sessionId || e.sessionId === sessionId));
        if (!arrived || result.retryable || Date.now() >= end) return;
      }
    }, { giveUpMs: lockWaitMs });
  } catch {
    result.retryable = true;
  }
  return result;
}

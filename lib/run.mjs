import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, fstatSync, openSync, readSync, readdirSync, renameSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { withLock, git, worktreeOf, stampHook, loadWorktree, saveWorktree, loadRun, saveRun, remove, readJson, writeJsonAtomic, LockTimeout } from './state.mjs';
import { append, enqueue, rewrite } from './outbox.mjs';
import { clientRunId } from './flush.mjs';
import { resolveWorkspace, committedLine } from './workspace.mjs';
import { repoSlug } from './git.mjs';
import { detector } from './detect.mjs';
import { clean } from './scrub.mjs';
import { endpoints } from './endpoints.mjs';
import { createClient } from './api.mjs';
import { credentialStore } from './credentials.mjs';
import { reconcile } from './reconcile.mjs';
import { parseTodos, relPath } from './plans.mjs';
import { stopGate } from './gate.mjs';
import { eventId } from './ids.mjs';
import { readSession, sizesOf } from './usage.mjs';
import { codexEvents, addModelUsage } from './codex.mjs';
import { remind, linkedLine } from './remind.mjs';

export const LINK_ASK = 'eocrm: this session isn\'t linked to a task. Ask the member once which task key it is for (or "none"), then use the eocrm link-run skill.';
const TASK_KEY = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]{1,9}-[0-9]+(?![A-Za-z0-9])/;
const HEARTBEAT_MS = 120000;
const LOG_MAX = 256 * 1024;
const TRANSCRIPT_TAIL = 256 * 1024;
const SESSION_END_LOCK_MS = 500;
// Under SessionStart's 10 s hook timeout.
const SESSION_START_MS = 8000;
const LOCK_MS = 1500;
const PRUNE_MS = 7 * 24 * 3600 * 1000;
const TOMBSTONE_MS = 90 * 24 * 3600 * 1000;
const MAX_RUNS_READ = 50;
const NEW_SESSION = new Set(['startup', 'clear']);
const LINKED_LINE_SOURCES = new Set(['startup', 'resume', 'clear']);
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const RECONCILE_EVERY_MS = 5 * 60 * 1000;
const RECONCILE_MS = { SessionStart: 3000, Stop: 10000, PostToolUse: 10000 };
const KEEP_WRITTEN = 50;
const WRITES = new Set(['Write', 'Edit', 'MultiEdit']);
const TODOS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate']);
const LEDGER_FILE = /^\.superpowers\/sdd\/[^/]+\/progress\.md$/;
const WAITING = { permission_prompt: 'permission', idle_prompt: 'idle' };
const DISPATCH = fileURLToPath(new URL('../hooks/dispatch.mjs', import.meta.url));

export function logError(data, error) {
  try {
    const file = join(data, 'plugin.log');
    try {
      if (statSync(file).size > LOG_MAX) renameSync(file, `${file}.1`);
    } catch {
      // no log yet
    }
    appendFileSync(file, `${new Date().toISOString()} ${clean(String(error?.stack ?? error), 4000)}\n`);
  } catch {
    // nowhere left to report
  }
}

export function spawnFlush(ctx) {
  try {
    (ctx.spawn ?? spawn)(process.execPath, [DISPATCH, 'flush', '--data', ctx.data, ...(ctx.harness === 'codex' ? ['--harness', 'codex'] : [])], { detached: true, stdio: 'ignore', windowsHide: true, env: ctx.env })
      .on('error', (e) => logError(ctx.data, e))
      .unref();
  } catch (e) {
    logError(ctx.data, e);
  }
}

export const waitMs = (cap, end) => (end === undefined ? cap : Math.max(1, Math.min(cap, end - Date.now())));

export function runClient(ctx, { timeoutMs, end } = {}) {
  const store = ctx.store ?? credentialStore({ data: ctx.data });
  const hookStore = { get: (key) => store.get(key, { timeoutMs: waitMs(2500, end) }), update: (key, fn) => store.update(key, fn, { timeoutMs: waitMs(2500, end) }) };
  return (run) => createClient({ endpoints: endpoints({ region: run.region, env: ctx.env }), workspace: run.workspace, store: hookStore, harness: ctx.harness, lockTimeoutMs: waitMs(2500, end), ...(timeoutMs ? { timeoutMs } : {}) });
}

function transcriptModel(path) {
  if (typeof path !== 'string' || !path) return null;
  let text;
  try {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, TRANSCRIPT_TAIL));
      readSync(fd, buf, 0, buf.length, size - buf.length);
      text = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"assistant"')) continue;
    try {
      const o = JSON.parse(lines[i]);
      const model = o?.message?.model;
      // <synthetic> marks Claude Code's own error/placeholder turns, not a model.
      if (o.type === 'assistant' && !o.isSidechain && typeof model === 'string' && model && model !== '<synthetic>') return model;
    } catch {
      // a partial first line of the tail
    }
  }
  return null;
}

export function linkContext(worktree, branch, worktreeRoot) {
  if (worktree.taskKey || worktree.linkAnswered) return null;
  if (TASK_KEY.test(branch ?? '') || TASK_KEY.test(basename(worktreeRoot ?? ''))) return null;
  return LINK_ASK;
}

// Reads only the newest runs; a sweep also finishes runs idle past PRUNE_MS and deletes them once settled.
export function runsOf(data, worktreeKey, sweep) {
  const dir = join(data, 'runs');
  let files;
  try {
    files = readdirSync(dir).filter((n) => n.endsWith('.json')).flatMap((n) => {
      try {
        return [{ sid: n.slice(0, -5), mtime: statSync(join(dir, n)).mtimeMs }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const runs = [];
  for (const [i, f] of files.entries()) {
    const old = sweep && f.sid !== sweep.sid && sweep.at - f.mtime > PRUNE_MS;
    if (i >= MAX_RUNS_READ && !old) continue;
    let run;
    try {
      run = loadRun(data, f.sid);
    } catch {
      continue;
    }
    if (old && !run.ended) {
      saveRun(data, f.sid, { ended: true });
      append(data, { kind: 'finish', sessionId: f.sid });
    } else if (old && !sweep.busy.has(f.sid)) {
      tombstone(data, f.sid, run.generation ?? 0, sweep.at);
      remove(join(dir, `${f.sid}.json`));
    }
    else if (!old && run.worktreeKey === worktreeKey) runs.push(run);
  }
  return runs;
}

const tombstones = (data) => join(data, 'generations.json');

// A pruned run's generation outlives its file, so a later resume never reuses an ended client_run_id.
function tombstone(data, sid, generation, at) {
  const kept = Object.entries(readJson(tombstones(data), {})).filter(([, t]) => at - t.at <= TOMBSTONE_MS);
  writeJsonAtomic(tombstones(data), { ...Object.fromEntries(kept), [sid]: { generation, at } });
}

function gather(data, cwd) {
  const wt = worktreeOf(cwd);
  const origin = git(cwd, ['remote', 'get-url', 'origin']);
  const branch = git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return { wt, origin, branch, ws: resolveWorkspace({ data, cwd, wt, origin }) };
}

const isFinishOf = (sid) => (e) => e.sessionId === sid && e.kind === 'finish';
const placeOf = (ws) => `${ws.region} ${ws.workspace}`;

export async function ensureRun(ctx, input, facts = gather(ctx.data, input.cwd)) {
  const { data } = ctx;
  const sid = input.session_id;
  loadRun(data, sid);
  const { wt, origin, branch, ws } = facts;
  if (!ws.workspace || !ws.region) return null;
  const repo = repoSlug(input.cwd, origin);
  const { taskKey } = loadWorktree(data, wt.key);
  const place = { ...(branch ? { branch } : {}), worktree: basename(wt.root), ...(repo ? { repo } : {}) };
  const at = ctx.now();
  const run = await withLock(data, async () => {
    let pending = [];
    rewrite(data, (entries) => {
      pending = entries;
      return entries.filter((e) => !isFinishOf(sid)(e));
    });
    const busy = new Set(pending.map((e) => e.sessionId));
    for (const other of runsOf(data, wt.key, { sid, at, busy })) {
      if (other.sessionId === sid || other.ended || !facts.newSession) continue;
      saveRun(data, other.sessionId, { ended: true });
      append(data, { kind: 'finish', sessionId: other.sessionId });
    }
    const prev = loadRun(data, sid);
    const where = placeOf(ws);
    const moved = Boolean(prev.startedAt) && (prev.workspace !== ws.workspace || prev.region !== ws.region);
    const finished = prev.ended && !pending.some(isFinishOf(sid));
    const linked = moved ? (prev.linkedFor === where ? prev.linkedTask : null) : prev.linkedTask;
    const task = linked !== undefined ? linked : prev.startedAt ? (prev.start?.task ?? null) : taskKey;
    const start = { ...(task ? { task } : {}), ...place };
    let patch = {};
    if (moved && !finished) {
      const old = `${sid}--w${prev.generation ?? 0}`;
      saveRun(data, old, { ...prev, sessionId: old, owner: sid, ended: true });
      rewrite(data, (entries) => entries.map((e) => (e.sessionId === sid ? { ...e, sessionId: old } : e)));
      append(data, { kind: 'finish', sessionId: old });
    }
    if (!prev.startedAt) {
      const buried = readJson(tombstones(data), {})[sid];
      const generation = Number.isInteger(buried?.generation) ? buried.generation + 1 : 0;
      patch = { generation, clientRunId: clientRunId(sid, generation), startedAt: at };
      if (buried && typeof input.transcript_path === 'string') patch.usageOffsets = sizesOf(input.transcript_path);
    }
    else if (moved || finished) {
      const generation = (prev.generation ?? 0) + 1;
      patch = { generation, clientRunId: clientRunId(sid, generation), runId: null, acked: {}, serverEventsRead: false, conventions: null, conventionsAt: null, startHead: null, ownCommits: [], model: null, modelChanges: 0, waiting: false, ...(moved ? { ackPending: [] } : {}) };
    }
    if (moved || prev.linkedTask === undefined) Object.assign(patch, { linkedTask: task ?? null, linkedFor: where });
    const next = saveRun(data, sid, { ...patch, ended: false, startBlocked: null, start, workspace: ws.workspace, region: ws.region, worktreeKey: wt.key });
    if (next.runId) return next;
    append(data, { kind: 'start', sessionId: sid });
    return saveRun(data, sid, { lastHeartbeatAt: at });
  }, { giveUpMs: LOCK_MS });
  (ctx.spawnFlush ?? spawnFlush)(ctx);
  return run;
}

function modelOf(input) {
  return transcriptModel(input.transcript_path) ?? (typeof input.model === 'string' && input.model ? input.model : null);
}

async function tick(ctx, input, detected = () => false, { spawn = true, end } = {}) {
  const { data } = ctx;
  const sid = input.session_id;
  const model = modelOf(input);
  const at = ctx.now();
  const queued = await withLock(data, async () => {
    const current = loadRun(data, sid);
    if (current.ended) return false;
    const found = detected(current, at);
    const patch = {};
    if (model && model !== current.model) {
      const n = current.modelChanges ?? 0;
      const id = `model-${createHash('sha256').update(model).digest('base64url').slice(0, 22)}-${current.generation ?? 0}-${n}`;
      append(data, { kind: 'event', sessionId: sid, event: { id, type: 'usage', occurred_at: new Date(at).toISOString(), model: clean(model, 100) } });
      Object.assign(patch, { model, modelChanges: n + 1 });
    }
    if (at - (current.lastHeartbeatAt ?? 0) >= HEARTBEAT_MS) {
      append(data, { kind: 'heartbeat', sessionId: sid });
      patch.lastHeartbeatAt = at;
    }
    if (!Object.keys(patch).length) return found;
    saveRun(data, sid, patch);
    return true;
  }, { giveUpMs: waitMs(LOCK_MS, end) });
  if (queued && spawn) (ctx.spawnFlush ?? spawnFlush)(ctx);
}

async function sessionStart(ctx, input) {
  const end = Date.now() + SESSION_START_MS;
  const facts = { ...gather(ctx.data, input.cwd), newSession: NEW_SESSION.has(input.source) };
  const tracked = Boolean(facts.ws.workspace && facts.ws.region);
  try {
    if (await ensureRun(ctx, input, facts)) {
      await tick(ctx, input, undefined, { end });
      await reconcileNow(ctx, input, 'SessionStart', end);
    }
  } catch (e) {
    if (!(e instanceof LockTimeout)) throw e;
    logError(ctx.data, e);
  }
  const lines = [];
  const worktree = loadWorktree(ctx.data, facts.wt.key);
  const task = tracked ? loadRun(ctx.data, input.session_id).start?.task : null;
  if (task && LINKED_LINE_SOURCES.has(input.source)) lines.push(linkedLine(task));
  if (tracked && facts.branch) {
    const ask = linkContext(worktree, facts.branch, facts.wt.root);
    if (ask) lines.push(ask);
  }
  const { pending } = facts.ws;
  const asked = pending && `${pending.workspace} ${pending.region}`;
  if (asked && worktree.committedAsked !== asked) {
    lines.push(committedLine(pending));
    saveWorktree(ctx.data, facts.wt.key, { committedAsked: asked });
  }
  return lines.length ? { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } }) } : {};
}

async function endRun(ctx, input) {
  const { data } = ctx;
  const sid = input.session_id;
  let queued;
  try {
    queued = await withLock(data, async () => {
      const run = loadRun(data, sid);
      if (!run.startedAt || run.ended) return false;
      const left = codexUsageEvents(run, input);
      const occurred_at = new Date(ctx.now()).toISOString();
      if (left.events.length) append(data, ...left.events.map((event) => ({ kind: 'event', sessionId: sid, event: { ...event, occurred_at } })));
      saveRun(data, sid, { ended: true, ...left.patch });
      append(data, { kind: 'finish', sessionId: sid });
      return true;
    }, { giveUpMs: SESSION_END_LOCK_MS });
  } catch (e) {
    if (!(e instanceof LockTimeout)) throw e;
    if (!loadRun(data, sid).startedAt) return {};
    await enqueue(data, { kind: 'finish', sessionId: sid }, { giveUpMs: 0 });
    queued = true;
  }
  if (queued) (ctx.spawnFlush ?? spawnFlush)(ctx);
  return {};
}

// Records Write/Edit paths and todo state; true when the change moves the plan or ledger.
async function track(ctx, input) {
  const tool = input.tool_name;
  const ti = input.tool_input ?? {};
  const files = (Array.isArray(ti.file_paths) ? ti.file_paths : [ti.file_path]).filter((f) => typeof f === 'string' && f !== '');
  const write = WRITES.has(tool) && files.length > 0;
  if (!write && !TODOS.has(tool)) return false;
  const root = write ? worktreeOf(input.cwd).root : null;
  return withLock(ctx.data, async () => {
    const cur = loadRun(ctx.data, input.session_id);
    if (!write) {
      saveRun(ctx.data, input.session_id, { todos: parseTodos(input, cur.todos).todos });
      return true;
    }
    const written = Array.isArray(cur.written) ? cur.written.filter((f) => !files.includes(f)) : [];
    saveRun(ctx.data, input.session_id, { written: [...written, ...files].slice(-KEEP_WRITTEN) });
    return files.some((f) => {
      const rel = relPath(root, f);
      return rel !== null && (LEDGER_FILE.test(rel) || rel === cur.planPath);
    });
  }, { giveUpMs: LOCK_MS });
}

export async function reconcileNow(ctx, input, event, end) {
  const { data } = ctx;
  try {
    const run = await withLock(data, async () => {
      const cur = loadRun(data, input.session_id);
      return cur.startedAt && !cur.ended ? saveRun(data, input.session_id, { reconciledAt: ctx.now() }) : null;
    }, { giveUpMs: waitMs(LOCK_MS, end) });
    if (!run) return;
    const deadlineMs = waitMs(RECONCILE_MS[event], end);
    const clientFor = ctx.clientFor ?? runClient(ctx, { timeoutMs: Math.min(3000, deadlineMs / 2), end });
    const { enqueued } = await (ctx.reconcile ?? reconcile)({ ...ctx, cwd: input.cwd, clientFor }, run, { deadlineMs });
    if (enqueued && event !== 'Stop') (ctx.spawnFlush ?? spawnFlush)(ctx);
  } catch (e) {
    logError(data, e);
  }
}

function codexUsageEvents(run, input) {
  const stops = run.codexStops ?? 0;
  const turnId = input.turn_id ?? (run.turns ?? 0) - 1;
  const events = Object.entries(run.codexUsage ?? {})
    .filter(([, c]) => Object.values(c).some((v) => v > 0))
    .map(([model, c]) => ({ id: eventId('usage', `${run.sessionId}:${run.generation ?? 0}:codex:${turnId}:${stops}:${model}`), type: 'usage', model: clean(model, 100), ...c }));
  return { events, patch: { codexUsage: {}, codexStops: stops + (events.length ? 1 : 0) } };
}

// Only fixed fields: the hook's message and title never leave.
export function signals(event, run, input, harness) {
  const key = `${run.sessionId}:${run.generation ?? 0}`;
  const waits = run.waits ?? 0;
  const turns = run.turns ?? 0;
  const resumed = run.waiting ? [{ id: eventId('resumed', `${key}:${waits - 1}`), type: 'resumed' }] : [];
  if (event === 'Notification') return run.waiting ? null : { events: [{ id: eventId('waiting', `${key}:${waits}`), type: 'waiting', kind: WAITING[input.notification_type] ?? 'question' }], patch: { waiting: true, waits: waits + 1 } };
  if (event === 'Resume') return resumed.length ? { events: resumed, patch: { waiting: false } } : null;
  if (event === 'UserPromptSubmit') return { events: [...resumed, { id: eventId('turn', `${key}:${turns}:started`), type: 'turn', phase: 'started' }], patch: { waiting: false, turns: turns + 1, codexStops: 0 } };
  if (event === 'Stop' && harness === 'codex') {
    const usage = codexUsageEvents(run, input);
    return { events: [...resumed, { id: eventId('turn', `${key}:${turns - 1}:ended`), type: 'turn', phase: 'ended' }, ...usage.events], patch: { waiting: false, ...usage.patch } };
  }
  if (event === 'Stop') {
    const read = typeof input.transcript_path === 'string' && input.transcript_path ? readSession(input.transcript_path, run.usageOffsets, run.usageSeen, undefined, run.usageEpochs) : { offsets: run.usageOffsets ?? {}, epochs: run.usageEpochs ?? {}, ids: [], reads: [] };
    const usage = read.reads.flatMap(({ file, from, epoch, models }) => Object.entries(models)
      .filter(([, c]) => Object.values(c).some((n) => n > 0))
      .map(([model, c]) => ({ id: eventId('usage', `${key}:${file}:${epoch}:${from}:${model}`), type: 'usage', model: clean(model, 100), ...c })));
    return { events: [...resumed, { id: eventId('turn', `${key}:${turns - 1}:ended`), type: 'turn', phase: 'ended' }, ...usage], patch: { waiting: false, usageOffsets: read.offsets, usageEpochs: read.epochs, usageSeen: [...(run.usageSeen ?? []), ...read.ids].slice(-200) } };
  }
  return null;
}

function queueSignals(data, event, input, harness) {
  return (current, at) => {
    const s = signals(event, current, input, harness);
    if (!s) return false;
    const occurred_at = new Date(at).toISOString();
    append(data, ...s.events.map((e) => ({ kind: 'event', sessionId: current.sessionId, event: { ...e, occurred_at } })));
    saveRun(data, current.sessionId, event === 'Stop' ? { ...s.patch, lastStopAt: at } : s.patch);
    return true;
  };
}

async function signal(ctx, event, input) {
  if (event === 'Resume' && !loadRun(ctx.data, input.session_id).waiting) return {};
  const queued = await withLock(ctx.data, async () => {
    const run = loadRun(ctx.data, input.session_id);
    return run.startedAt && !run.ended && queueSignals(ctx.data, event, input)(run, ctx.now());
  }, { giveUpMs: LOCK_MS });
  if (queued) (ctx.spawnFlush ?? spawnFlush)(ctx);
  return {};
}

export async function handle(event, input, ctx) {
  if (ctx.harness !== 'codex') return core(event, input, ctx);
  try {
    stampHook(ctx.data, worktreeOf(input.cwd).key, ctx.now());
  } catch (e) {
    logError(ctx.data, e);
  }
  let out = {};
  for (const c of codexEvents(event, input)) {
    const r = await (ctx.core ?? core)(c.event, c.input, ctx);
    if (r.stdout && !(out.stdout && JSON.parse(out.stdout).decision)) out = r;
  }
  return out;
}

async function core(event, input, ctx) {
  if (typeof input?.cwd !== 'string') throw new Error('eocrm: hook input lacks cwd');
  if (event === 'Resume' || event === 'Notification') return signal(ctx, event, input);
  if (event === 'SessionEnd') return endRun(ctx, input);
  if (event === 'Remind') return remind(ctx, input.hook_event_name, input);
  if (event === 'SessionStart') return sessionStart(ctx, input);
  if (event === 'PostModelRequest') return modelUsage(ctx, input);
  if (event === 'Stop') {
    const out = await stopGate(ctx, input, (end) => turn(event, input, ctx, end));
    if (ctx.harness === 'codex' && !out.stdout) await signal(ctx, 'Notification', { ...input, notification_type: 'idle_prompt' });
    return out;
  }
  const t = await turn(event, input, ctx);
  const due = t && event === 'PostToolUse' && ctx.now() - (loadRun(ctx.data, input.session_id).reconciledAt ?? 0) >= RECONCILE_EVERY_MS;
  if (t && (t.urgent || due)) await reconcileNow(ctx, input, 'PostToolUse');
  return {};
}

async function modelUsage(ctx, input) {
  await withLock(ctx.data, async () => {
    const run = loadRun(ctx.data, input.session_id);
    const patch = run.startedAt && !run.ended && addModelUsage(run, input);
    if (patch) saveRun(ctx.data, input.session_id, patch);
  }, { giveUpMs: LOCK_MS });
  return {};
}

async function turn(event, input, ctx, end) {
  const run = loadRun(ctx.data, input.session_id);
  if (!run.startedAt || (event === 'UserPromptSubmit' && run.ended)) {
    if (!(await ensureRun(ctx, input))) return null;
  }
  let urgent = false;
  if (event === 'PostToolUse') {
    try {
      urgent = await track(ctx, input);
    } catch (e) {
      logError(ctx.data, e);
    }
  }
  // Stop flushes inline in the gate.
  await tick(ctx, input, TOOL_EVENTS.has(event) ? detector(ctx, { ...input, hook_event_name: event }) : queueSignals(ctx.data, event, input, ctx.harness), { spawn: event !== 'Stop', end });
  return { urgent };
}

// Relinks only sessionId's run.
export async function linkWorktree(ctx, cwd, taskKey, sessionId) {
  const wt = worktreeOf(cwd);
  const ws = resolveWorkspace({ data: ctx.data, cwd, wt, origin: git(cwd, ['remote', 'get-url', 'origin']) });
  const { queued, others } = await withLock(ctx.data, async () => {
    saveWorktree(ctx.data, wt.key, { root: wt.root, taskKey, linkAnswered: true });
    const live = runsOf(ctx.data, wt.key).filter((r) => !r.ended);
    const mine = sessionId ? loadRun(ctx.data, sessionId) : {};
    let queued = false;
    if (mine.startedAt) {
      const start = { ...mine.start };
      delete start.task;
      const patch = { linkedTask: taskKey, linkedFor: placeOf(ws) };
      if (!mine.ended && !(mine.workspace && ws.workspace && placeOf(mine) !== placeOf(ws))) {
        Object.assign(patch, { startBlocked: null, start: taskKey ? { task: taskKey, ...start } : start });
        append(ctx.data, { kind: 'task', sessionId, task: taskKey });
        queued = true;
      }
      saveRun(ctx.data, sessionId, patch);
    }
    return { queued, others: live.filter((r) => r.sessionId !== sessionId).map((r) => ({ task: r.start?.task ?? null })) };
  });
  if (queued) (ctx.spawnFlush ?? spawnFlush)(ctx);
  return { others };
}

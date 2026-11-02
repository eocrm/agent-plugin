import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, fstatSync, openSync, readSync, readdirSync, renameSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { withLock, git, worktreeOf, loadWorktree, saveWorktree, loadRun, saveRun, remove, readJson, writeJsonAtomic, LockTimeout } from './state.mjs';
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

export const LINK_ASK = 'eocrm: this session isn\'t linked to a task. Ask the member once which task key it is for (or "none"), then use the eocrm link-run skill.';
const TASK_KEY = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]{1,9}-[0-9]+(?![A-Za-z0-9])/;
const HEARTBEAT_MS = 120000;
const LOG_MAX = 256 * 1024;
const TRANSCRIPT_TAIL = 256 * 1024;
const SESSION_END_LOCK_MS = 500;
const LOCK_MS = 1500;
const PRUNE_MS = 7 * 24 * 3600 * 1000;
const TOMBSTONE_MS = 90 * 24 * 3600 * 1000;
const MAX_RUNS_READ = 50;
const NEW_SESSION = new Set(['startup', 'clear']);
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const RECONCILE_EVERY_MS = 5 * 60 * 1000;
const RECONCILE_MS = { SessionStart: 3000, Stop: 10000, PostToolUse: 10000 };
const KEEP_WRITTEN = 50;
const WRITES = new Set(['Write', 'Edit', 'MultiEdit']);
const TODOS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate']);
const LEDGER_FILE = /^\.superpowers\/sdd\/[^/]+\/progress\.md$/;
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
    spawn(process.execPath, [DISPATCH, 'flush', '--data', ctx.data], { detached: true, stdio: 'ignore', windowsHide: true, env: ctx.env })
      .on('error', (e) => logError(ctx.data, e))
      .unref();
  } catch (e) {
    logError(ctx.data, e);
  }
}

export function runClient(ctx, { timeoutMs } = {}) {
  const store = ctx.store ?? credentialStore({ data: ctx.data });
  const hookStore = { get: (key) => store.get(key, { timeoutMs: 2500 }), update: (key, fn) => store.update(key, fn, { timeoutMs: 2500 }) };
  return (run) => createClient({ endpoints: endpoints({ region: run.region, env: ctx.env }), workspace: run.workspace, store: hookStore, ...(timeoutMs ? { timeoutMs } : {}) });
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
function runsOf(data, worktreeKey, sweep) {
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

export async function ensureRun(ctx, input, facts = gather(ctx.data, input.cwd)) {
  const { data } = ctx;
  const sid = input.session_id;
  loadRun(data, sid);
  const { wt, origin, branch, ws } = facts;
  if (!ws.workspace || !ws.region) return null;
  const repo = repoSlug(input.cwd, origin);
  const { taskKey } = loadWorktree(data, wt.key);
  const start = { ...(taskKey ? { task: taskKey } : {}), ...(branch ? { branch } : {}), worktree: basename(wt.root), ...(repo ? { repo } : {}) };
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
    let patch = {};
    if (!prev.startedAt) {
      const buried = readJson(tombstones(data), {})[sid];
      const generation = Number.isInteger(buried?.generation) ? buried.generation + 1 : 0;
      patch = { generation, clientRunId: clientRunId(sid, generation), startedAt: at };
    }
    else if (prev.ended && !pending.some(isFinishOf(sid))) {
      const generation = (prev.generation ?? 0) + 1;
      patch = { generation, clientRunId: clientRunId(sid, generation), runId: null, acked: {}, serverEventsRead: false, conventions: null, startHead: null, ownCommits: [], model: null, modelChanges: 0 };
    }
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

async function tick(ctx, input, detected = () => false) {
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
  }, { giveUpMs: LOCK_MS });
  if (queued) (ctx.spawnFlush ?? spawnFlush)(ctx);
}

async function sessionStart(ctx, input) {
  const facts = { ...gather(ctx.data, input.cwd), newSession: NEW_SESSION.has(input.source) };
  const tracked = Boolean(facts.ws.workspace && facts.ws.region);
  try {
    if (await ensureRun(ctx, input, facts)) {
      await tick(ctx, input);
      await reconcileNow(ctx, input, 'SessionStart');
    }
  } catch (e) {
    if (!(e instanceof LockTimeout)) throw e;
    logError(ctx.data, e);
  }
  const lines = [];
  const worktree = loadWorktree(ctx.data, facts.wt.key);
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
      saveRun(data, sid, { ended: true });
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
  const file = input.tool_input?.file_path;
  const write = WRITES.has(tool) && typeof file === 'string' && file !== '';
  if (!write && !TODOS.has(tool)) return false;
  const rel = write ? relPath(worktreeOf(input.cwd).root, file) : null;
  return withLock(ctx.data, async () => {
    const cur = loadRun(ctx.data, input.session_id);
    if (!write) {
      saveRun(ctx.data, input.session_id, { todos: parseTodos(input, cur.todos).todos });
      return true;
    }
    const written = Array.isArray(cur.written) ? cur.written.filter((f) => f !== file) : [];
    saveRun(ctx.data, input.session_id, { written: [...written, file].slice(-KEEP_WRITTEN) });
    return rel !== null && (LEDGER_FILE.test(rel) || rel === cur.planPath);
  }, { giveUpMs: LOCK_MS });
}

async function reconcileNow(ctx, input, event) {
  const { data } = ctx;
  try {
    const run = await withLock(data, async () => {
      const cur = loadRun(data, input.session_id);
      return cur.startedAt && !cur.ended ? saveRun(data, input.session_id, { reconciledAt: ctx.now() }) : null;
    }, { giveUpMs: LOCK_MS });
    if (!run) return;
    const deadlineMs = RECONCILE_MS[event];
    const clientFor = ctx.clientFor ?? runClient(ctx, { timeoutMs: Math.min(3000, deadlineMs / 2) });
    const { enqueued } = await (ctx.reconcile ?? reconcile)({ ...ctx, cwd: input.cwd, clientFor }, run, { deadlineMs });
    if (enqueued) (ctx.spawnFlush ?? spawnFlush)(ctx);
  } catch (e) {
    logError(data, e);
  }
}

export async function handle(event, input, ctx) {
  if (typeof input?.cwd !== 'string') throw new Error('eocrm: hook input lacks cwd');
  if (event === 'SessionEnd') return endRun(ctx, input);
  if (event === 'SessionStart') return sessionStart(ctx, input);
  const run = loadRun(ctx.data, input.session_id);
  if (!run.startedAt || (event === 'UserPromptSubmit' && run.ended)) {
    if (!(await ensureRun(ctx, input))) return {};
  }
  let urgent = false;
  if (event === 'PostToolUse') {
    try {
      urgent = await track(ctx, input);
    } catch (e) {
      logError(ctx.data, e);
    }
  }
  await tick(ctx, input, TOOL_EVENTS.has(event) ? detector(ctx, { ...input, hook_event_name: event }) : undefined);
  const due = event === 'PostToolUse' && ctx.now() - (loadRun(ctx.data, input.session_id).reconciledAt ?? 0) >= RECONCILE_EVERY_MS;
  if (event === 'Stop' || urgent || due) await reconcileNow(ctx, input, event === 'Stop' ? 'Stop' : 'PostToolUse');
  return {};
}

export async function linkWorktree(ctx, cwd, taskKey) {
  const wt = worktreeOf(cwd);
  const queued = await withLock(ctx.data, async () => {
    saveWorktree(ctx.data, wt.key, { root: wt.root, taskKey, linkAnswered: true });
    const live = runsOf(ctx.data, wt.key).filter((r) => !r.ended);
    for (const r of live) {
      const start = { ...r.start };
      delete start.task;
      saveRun(ctx.data, r.sessionId, { startBlocked: null, start: taskKey ? { task: taskKey, ...start } : start });
      if (taskKey) append(ctx.data, { kind: 'task', sessionId: r.sessionId, task: taskKey });
    }
    return live.length > 0;
  });
  if (queued) (ctx.spawnFlush ?? spawnFlush)(ctx);
}

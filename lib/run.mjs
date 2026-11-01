import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, fstatSync, openSync, readSync, readdirSync, renameSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { withLock, git, worktreeOf, loadWorktree, saveWorktree, loadRun, saveRun, remove, LockTimeout } from './state.mjs';
import { append, enqueue, rewrite } from './outbox.mjs';
import { clientRunId } from './flush.mjs';
import { resolveWorkspace, committedLine } from './workspace.mjs';
import { repoSlug } from './git.mjs';
import { clean } from './scrub.mjs';
import { endpoints } from './endpoints.mjs';
import { createClient } from './api.mjs';
import { credentialStore } from './credentials.mjs';

export const LINK_ASK = 'eocrm: this session isn\'t linked to a task. Ask the member once which task key it is for (or "none"), then use the eocrm link-run skill.';
export const TASK_KEY = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]{1,9}-[0-9]+(?![A-Za-z0-9])/;
const HEARTBEAT_MS = 120000;
const LOG_MAX = 256 * 1024;
const TRANSCRIPT_TAIL = 256 * 1024;
const SESSION_END_LOCK_MS = 500;
const LOCK_MS = 1500;
const PRUNE_MS = 7 * 24 * 3600 * 1000;
const MAX_RUNS_READ = 50;
const NEW_SESSION = new Set(['startup', 'clear']);
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

export function runClient(ctx) {
  const store = ctx.store ?? credentialStore({ data: ctx.data });
  const hookStore = { get: (key) => store.get(key, { timeoutMs: 2500 }), update: (key, fn) => store.update(key, fn, { timeoutMs: 2500 }) };
  return (run) => createClient({ endpoints: endpoints({ region: run.region, env: ctx.env }), workspace: run.workspace, store: hookStore });
}

export function transcriptModel(path) {
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
    } else if (old && !sweep.busy.has(f.sid)) remove(join(dir, `${f.sid}.json`));
    else if (!old && run.worktreeKey === worktreeKey) runs.push(run);
  }
  return runs;
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
    if (!prev.startedAt) patch = { generation: 0, clientRunId: clientRunId(sid, 0), startedAt: at };
    else if (prev.ended && !pending.some(isFinishOf(sid))) {
      const generation = (prev.generation ?? 0) + 1;
      patch = { generation, clientRunId: clientRunId(sid, generation), runId: null, acked: {}, serverEventsRead: false, model: null, modelChanges: 0 };
    }
    const next = saveRun(data, sid, { ...patch, ended: false, start, workspace: ws.workspace, region: ws.region, worktreeKey: wt.key });
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

async function tick(ctx, input) {
  const { data } = ctx;
  const sid = input.session_id;
  const model = modelOf(input);
  const at = ctx.now();
  const queued = await withLock(data, async () => {
    const current = loadRun(data, sid);
    if (current.ended) return false;
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
    if (!Object.keys(patch).length) return false;
    saveRun(data, sid, patch);
    return true;
  }, { giveUpMs: LOCK_MS });
  if (queued) (ctx.spawnFlush ?? spawnFlush)(ctx);
}

async function sessionStart(ctx, input) {
  const facts = { ...gather(ctx.data, input.cwd), newSession: NEW_SESSION.has(input.source) };
  const run = await ensureRun(ctx, input, facts);
  if (run) await tick(ctx, input);
  const lines = [];
  const worktree = loadWorktree(ctx.data, facts.wt.key);
  if (run && facts.branch) {
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
    await enqueue(data, { kind: 'finish', sessionId: sid }, { giveUpMs: 0 });
    queued = true;
  }
  if (queued) (ctx.spawnFlush ?? spawnFlush)(ctx);
  return {};
}

export async function handle(event, input, ctx) {
  if (typeof input?.cwd !== 'string') throw new Error('eocrm: hook input lacks cwd');
  if (event === 'SessionEnd') return endRun(ctx, input);
  if (event === 'SessionStart') return sessionStart(ctx, input);
  const run = loadRun(ctx.data, input.session_id);
  if (!run.startedAt || (event === 'UserPromptSubmit' && run.ended)) {
    if (!(await ensureRun(ctx, input))) return {};
  }
  await tick(ctx, input);
  return {};
}

export async function linkWorktree(ctx, cwd, taskKey) {
  const wt = worktreeOf(cwd);
  const queued = await withLock(ctx.data, async () => {
    saveWorktree(ctx.data, wt.key, { root: wt.root, taskKey, linkAnswered: true });
    if (!taskKey) return false;
    const live = runsOf(ctx.data, wt.key).filter((r) => !r.ended);
    for (const r of live) append(ctx.data, { kind: 'task', sessionId: r.sessionId, task: taskKey });
    return live.length > 0;
  });
  if (queued) (ctx.spawnFlush ?? spawnFlush)(ctx);
}

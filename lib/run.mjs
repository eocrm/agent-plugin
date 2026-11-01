import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, fstatSync, openSync, readSync, readdirSync, renameSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { withLock, git, worktreeOf, loadWorktree, saveWorktree, loadRun, saveRun } from './state.mjs';
import { append, readOutbox, writeOutbox } from './outbox.mjs';
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

function runsOf(data, worktreeKey) {
  let names;
  try {
    names = readdirSync(join(data, 'runs'));
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    if (!n.endsWith('.json')) return [];
    try {
      const run = loadRun(data, n.slice(0, -5));
      return run.worktreeKey === worktreeKey ? [run] : [];
    } catch {
      return [];
    }
  });
}

export async function ensureRun(ctx, input) {
  const { data } = ctx;
  const { session_id: sid, cwd } = input;
  loadRun(data, sid);
  const ws = resolveWorkspace({ data, cwd });
  if (!ws.workspace || !ws.region) return null;
  const wt = worktreeOf(cwd);
  const branch = git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const repo = repoSlug(cwd);
  const { taskKey } = loadWorktree(data, wt.key);
  const start = { ...(taskKey ? { task: taskKey } : {}), ...(branch ? { branch } : {}), worktree: basename(wt.root), ...(repo ? { repo } : {}) };
  const at = ctx.now();
  const run = await withLock(data, async () => {
    for (const other of runsOf(data, wt.key)) {
      if (other.sessionId === sid || other.ended) continue;
      saveRun(data, other.sessionId, { ended: true });
      append(data, { kind: 'finish', sessionId: other.sessionId });
    }
    const prev = loadRun(data, sid);
    const outbox = readOutbox(data);
    const isFinish = (e) => e.sessionId === sid && e.kind === 'finish';
    let patch = {};
    if (!prev.startedAt) patch = { generation: 0, clientRunId: clientRunId(sid, 0), startedAt: at };
    else if (prev.ended && outbox.some(isFinish)) writeOutbox(data, outbox.filter((e) => !isFinish(e)));
    else if (prev.ended) {
      const generation = (prev.generation ?? 0) + 1;
      patch = { generation, clientRunId: clientRunId(sid, generation), runId: null, acked: {}, serverEventsRead: false, model: null };
    }
    const next = saveRun(data, sid, { ...patch, ended: false, start, workspace: ws.workspace, region: ws.region, worktreeKey: wt.key });
    if (next.runId) return next;
    append(data, { kind: 'start', sessionId: sid });
    return saveRun(data, sid, { lastHeartbeatAt: at });
  });
  (ctx.spawnFlush ?? spawnFlush)(ctx);
  return { ...run, pending: ws.pending };
}

async function track(ctx, input, event) {
  const { data } = ctx;
  const sid = input.session_id;
  let run = loadRun(data, sid);
  let pending = null;
  if (event === 'SessionStart' || !run.startedAt || (event === 'UserPromptSubmit' && run.ended)) {
    run = await ensureRun(ctx, input);
    if (!run) return null;
    pending = run.pending;
  }
  const model = (event === 'SessionStart' && typeof input.model === 'string' && input.model) || transcriptModel(input.transcript_path);
  const at = ctx.now();
  const queued = await withLock(data, async () => {
    const current = loadRun(data, sid);
    if (current.ended) return false;
    const patch = {};
    if (model && model !== current.model) {
      const generation = current.generation ?? 0;
      const id = `model-${createHash('sha256').update(model).digest('base64url').slice(0, 22)}-${generation}`;
      append(data, { kind: 'event', sessionId: sid, event: { id, type: 'usage', occurred_at: new Date(at).toISOString(), model: clean(model, 100) } });
      patch.model = model;
    }
    if (at - (current.lastHeartbeatAt ?? 0) >= HEARTBEAT_MS) {
      append(data, { kind: 'heartbeat', sessionId: sid });
      patch.lastHeartbeatAt = at;
    }
    if (!Object.keys(patch).length) return false;
    saveRun(data, sid, patch);
    return true;
  });
  if (queued) (ctx.spawnFlush ?? spawnFlush)(ctx);
  return { run: loadRun(data, sid), pending };
}

function sessionStartContext(ctx, run, pending) {
  const lines = [];
  const worktree = loadWorktree(ctx.data, run.worktreeKey);
  if (run.start?.branch) {
    const ask = linkContext(worktree, run.start.branch, run.start.worktree);
    if (ask) lines.push(ask);
  }
  const asked = pending && `${pending.workspace} ${pending.region}`;
  if (asked && worktree.committedAsked !== asked) {
    lines.push(committedLine(pending));
    saveWorktree(ctx.data, run.worktreeKey, { committedAsked: asked });
  }
  return lines.length ? { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } }) } : {};
}

async function endRun(ctx, input) {
  const { data } = ctx;
  const sid = input.session_id;
  const queued = await withLock(data, async () => {
    const run = loadRun(data, sid);
    if (!run.startedAt || run.ended) return false;
    saveRun(data, sid, { ended: true });
    append(data, { kind: 'finish', sessionId: sid });
    return true;
  }, { giveUpMs: SESSION_END_LOCK_MS });
  if (queued) (ctx.spawnFlush ?? spawnFlush)(ctx);
  return {};
}

export async function handle(event, input, ctx) {
  if (typeof input?.cwd !== 'string') throw new Error('eocrm: hook input lacks cwd');
  if (event === 'SessionEnd') return endRun(ctx, input);
  const tracked = await track(ctx, input, event);
  if (!tracked || event !== 'SessionStart') return {};
  return sessionStartContext(ctx, tracked.run, tracked.pending);
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

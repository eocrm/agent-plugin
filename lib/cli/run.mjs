import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { git, worktreeOf, withLock, loadRun, saveRun, loadWorktree, saveWorktree, liveDirOf, liveSession, gitTimeout, remove } from '../state.mjs';
import { append } from '../outbox.mjs';
import { eventId } from '../ids.mjs';
import { prStatus, repoSlug } from '../git.mjs';
import { taskFor } from '../detect.mjs';
import { cloneEntry, repoEntry } from '../workspace.mjs';
import { ensureRun, gather, handle, logError, reconcileNow, runClient, runsOf, spawnFlush } from '../run.mjs';
import { flush } from '../flush.mjs';
import { agentOf, detectAgent } from './attribute.mjs';

// A commit-bounded run ends when the next commit comes this long after the last one.
export const IDLE_MS = 60 * 60 * 1000;
export const HOOK_MS = 3000;
const HOOK_GIT_MS = 1000;
const LOCK_MS = 1500;
const KEEP_COMMITS = 1000;
const KEEP_OWN = 200;
const ENTRY = fileURLToPath(new URL('../../scripts/cli.mjs', import.meta.url));

export const sessionOf = (wtKey, agent) => `cli-${wtKey}-${agent}`;

export const liveRuns = (data, cwd) => runsOf(data, worktreeOf(cwd).key).filter((r) => !r.ended && r.sessionId.startsWith('cli-'));

export const pluginLive = (cwd, now) => {
  const dir = liveDirOf(cwd);
  return dir ? liveSession(dir, now) : null;
};

const queueFile = (data, wtKey) => join(data, 'cli-queue', `${wtKey}.jsonl`);

const readQueue = (file) => {
  try {
    return readFileSync(file, 'utf8').split('\n').flatMap((l) => {
      try {
        return l ? [JSON.parse(l)] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
};

function headCommit(cwd) {
  const [sha = '', subject = '', author = '', committer = '', ...body] = git(cwd, ['log', '-1', '--format=%H%x1f%s%x1f%an%x1f%cn%x1f%B']).split('\x1f');
  return { sha, subject, author, committer, message: body.join('\x1f') };
}

// An explicit run (run start) carries its agent to commits that show none.
export function agentFor(ctx, cwd, commit = {}) {
  const explicit = liveRuns(ctx.data, cwd).find((r) => r.explicit)?.agent;
  return detectAgent({ env: ctx.env, commit }) ?? explicit ?? agentOf({ env: {}, setting: repoEntry(ctx.data, cwd).agent });
}

export function spawnSync(ctx, cwd) {
  try {
    (ctx.spawn ?? spawn)(process.execPath, [ENTRY, 'sync', '--quiet', '--data', ctx.data], { cwd, detached: true, stdio: 'ignore', windowsHide: true, env: ctx.env })
      .on('error', (e) => logError(ctx.data, e))
      .unref();
  } catch (e) {
    logError(ctx.data, e);
  }
}

const finish = (ctx, cwd, sessionId, endedAt) => handle('SessionEnd', { cwd, session_id: sessionId }, { ...ctx, endedAt, spawnFlush: () => {} });
const lastAt = (run, at) => run.lastCommitAt ?? run.startedAt ?? at;
const endAt = (run, at) => new Date(Math.min(at, lastAt(run, at) + IDLE_MS)).toISOString();
const idle = (run, at) => !run.explicit && at - lastAt(run, at) > IDLE_MS;
const moved = (run, branch) => !run.explicit && (run.start?.branch ?? '') !== branch;

// Ends commit-bounded runs idle past IDLE_MS or left on another branch, stamped at the last commit plus IDLE_MS.
export async function endStale(ctx, cwd) {
  const branch = git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const stale = liveRuns(ctx.data, cwd).filter((r) => idle(r, ctx.now()) || moved(r, branch));
  for (const r of stale) await finish(ctx, cwd, r.sessionId, endAt(r, ctx.now()));
  return stale;
}

// Local only: queues the start; the caller sends.
export async function startRun(ctx, cwd, agent, { explicit = false, at = ctx.now() } = {}) {
  const facts = { ...gather(ctx.data, cwd), newSession: true };
  const sid = sessionOf(facts.wt.key, agent);
  const prev = loadRun(ctx.data, sid);
  if (prev.startedAt && !prev.ended && (idle(prev, at) || moved(prev, facts.branch))) await finish(ctx, cwd, sid, endAt(prev, at));
  const run = await ensureRun({ ...ctx, agent, spawnFlush: () => {} }, { session_id: sid, cwd }, facts);
  if (!run) return null;
  return withLock(ctx.data, async () => saveRun(ctx.data, sid, { agent, ...(explicit ? { explicit: true } : {}) }), { giveUpMs: LOCK_MS });
}

function remember(data, wtKey, shas) {
  const wt = loadWorktree(data, wtKey);
  const known = new Set(wt.reportedCommits);
  saveWorktree(data, wtKey, { reportedCommits: [...wt.reportedCommits, ...shas.filter((s) => !known.has(s))].slice(-KEEP_COMMITS) });
}

// The foreground hook only appends here; the detached sync starts runs and queues events.
async function postCommit(ctx, cwd) {
  const head = headCommit(cwd);
  if (!head.sha) return 'no commit';
  const wt = worktreeOf(cwd);
  const file = queueFile(ctx.data, wt.key);
  if (loadWorktree(ctx.data, wt.key).reportedCommits.includes(head.sha) || readQueue(file).some((q) => q.sha === head.sha)) return 'duplicate';
  if (pluginLive(cwd, ctx.now())) {
    await withLock(ctx.data, async () => remember(ctx.data, wt.key, [head.sha]), { giveUpMs: LOCK_MS });
    return 'quiet';
  }
  const agent = agentFor(ctx, cwd, head);
  if (!agent) return 'no agent';
  mkdirSync(join(ctx.data, 'cli-queue'), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ sha: head.sha, subject: head.subject, agent, at: ctx.now() })}\n`);
  (ctx.spawnSync ?? spawnSync)(ctx, cwd);
  return 'queued';
}

async function prePush(ctx, cwd) {
  if (pluginLive(cwd, ctx.now()) || !liveRuns(ctx.data, cwd).length) return 'quiet';
  (ctx.spawnSync ?? spawnSync)(ctx, cwd);
  return 'queued';
}

async function postCheckout(ctx, cwd, [, , branchFlag]) {
  if (branchFlag !== '1' || pluginLive(cwd, ctx.now()) || !liveRuns(ctx.data, cwd).length) return 'quiet';
  (ctx.spawnSync ?? spawnSync)(ctx, cwd);
  return 'queued';
}

const HOOKS = { 'post-commit': postCommit, 'pre-push': prePush, 'post-checkout': postCheckout };

// Never touches the network, and gives up after HOOK_MS: queues, then a detached process sends.
export async function runHook(ctx, name, cwd, args = []) {
  const hook = HOOKS[name];
  if (!hook) return 'unknown hook';
  const budget = ctx.hookMs ?? HOOK_MS;
  Object.assign(gitTimeout, { ms: HOOK_GIT_MS, deadline: Date.now() + budget });
  if (!cloneEntry(ctx.data, cwd).initialized) return 'not initialized';
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), budget);
    timer.unref?.();
  });
  try {
    return await Promise.race([hook(ctx, cwd, args), late]);
  } catch (e) {
    logError(ctx.data, e);
    return 'failed';
  } finally {
    clearTimeout(timer);
    gitTimeout.deadline = null;
  }
}

// Takes the queue by rename, so two syncs never process one commit twice.
async function drain(ctx, cwd) {
  const wt = worktreeOf(cwd);
  const file = queueFile(ctx.data, wt.key);
  const taken = `${file}.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    renameSync(file, taken);
  } catch {
    return;
  }
  const items = readQueue(taken).sort((a, b) => a.at - b.at);
  const repo = repoSlug(cwd);
  let i = 0;
  try {
    for (; i < items.length; i++) await queueCommit(ctx, cwd, wt, repo, items[i]);
  } catch (e) {
    appendFileSync(file, items.slice(i).map((item) => `${JSON.stringify(item)}\n`).join(''));
    throw e;
  } finally {
    remove(taken);
  }
}

async function queueCommit(ctx, cwd, wt, repo, item) {
  const run = await (ctx.startRun ?? startRun)(ctx, cwd, item.agent, { at: item.at });
  if (!run) return;
  const task = taskFor(ctx, { cwd, session_id: run.sessionId });
  await withLock(ctx.data, async () => {
    const cur = loadRun(ctx.data, run.sessionId);
    const occurred_at = new Date(item.at).toISOString();
    const task_key = task(cur);
    append(ctx.data,
      { kind: 'event', sessionId: cur.sessionId, event: { id: eventId('commit', item.sha), type: 'commit', occurred_at, sha: item.sha, subject: item.subject, ...(repo ? { repo } : {}), task_key } },
      // Between commits the run shows idle, not stalled.
      { kind: 'event', sessionId: cur.sessionId, event: { id: eventId('turn', `${cur.clientRunId}:${item.sha}`), type: 'turn', phase: 'ended', occurred_at, task_key } });
    saveRun(ctx.data, cur.sessionId, { lastCommitAt: item.at, ownCommits: [...new Set([...(cur.ownCommits ?? []), item.sha])].slice(-KEEP_OWN) });
    remember(ctx.data, wt.key, [item.sha]);
  }, { giveUpMs: LOCK_MS });
}

export async function queuePr(ctx, cwd, run) {
  const pr = (ctx.prStatus ?? prStatus)(cwd);
  if (!pr) return null;
  const id = eventId('pull_request', `${pr.action}:${pr.url}`);
  await withLock(ctx.data, async () => {
    const cur = loadRun(ctx.data, run.sessionId);
    if (cur.ended || cur.acked[id]) return;
    append(ctx.data, { kind: 'event', sessionId: cur.sessionId, event: { id, type: 'pull_request', occurred_at: new Date(ctx.now()).toISOString(), ...pr, repo: pr.url.split('/').slice(3, 5).join('/'), task_key: cur.start?.task ?? null } });
  }, { giveUpMs: LOCK_MS });
  return pr;
}

// Stale runs end, queued commits start or continue runs, then plans, reconcile and the PR check per live run, then a send.
export async function sync(ctx, cwd) {
  if (pluginLive(cwd, ctx.now())) return { quiet: true, runs: 0 };
  await endStale(ctx, cwd);
  await drain(ctx, cwd).catch((e) => logError(ctx.data, e));
  const runs = liveRuns(ctx.data, cwd);
  for (const run of runs) {
    await queuePr(ctx, cwd, run).catch((e) => logError(ctx.data, e));
    await reconcileNow({ ...ctx, spawnFlush: () => {} }, { session_id: run.sessionId, cwd }, 'Stop');
  }
  const result = await flush({ data: ctx.data, clientFor: runClient(ctx), harness: 'cli' });
  return { quiet: false, runs: runs.length, result };
}

export async function stopRuns(ctx, cwd) {
  const runs = liveRuns(ctx.data, cwd);
  for (const r of runs) await finish(ctx, cwd, r.sessionId);
  if (runs.length) (ctx.spawnFlush ?? spawnFlush)(ctx);
  return runs;
}

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { git, worktreeOf, withLock, loadRun, saveRun, loadWorktree, saveWorktree, liveDirOf, liveSession, gitTimeout } from '../state.mjs';
import { append } from '../outbox.mjs';
import { eventId } from '../ids.mjs';
import { budget, prStatus, repoSlug } from '../git.mjs';
import { taskFor } from '../detect.mjs';
import { repoEntry } from '../workspace.mjs';
import { ensureRun, gather, handle, logError, reconcileNow, runClient, runsOf, spawnFlush } from '../run.mjs';
import { flush } from '../flush.mjs';
import { agentOf, detectAgent } from './attribute.mjs';

// A commit-bounded run ends when the next commit comes this long after the last one.
export const IDLE_MS = 60 * 60 * 1000;
const HOOK_GIT_MS = 1000;
const LOCK_MS = 1500;
const KEEP_COMMITS = 1000;
const KEEP_OWN = 200;
const ENTRY = fileURLToPath(new URL('../../scripts/cli.mjs', import.meta.url));

export const sessionOf = (wtKey, agent) => `cli-${wtKey}-${agent}`;

const liveRuns = (data, cwd) => runsOf(data, worktreeOf(cwd).key).filter((r) => !r.ended && r.sessionId.startsWith('cli-'));

export const pluginLive = (cwd, now) => {
  const dir = liveDirOf(cwd);
  return dir ? liveSession(dir, now) : null;
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

async function finish(ctx, cwd, sessionId) {
  await handle('SessionEnd', { cwd, session_id: sessionId }, ctx);
}

// Local only: queues the start; the caller spawns the send.
export async function startRun(ctx, cwd, agent, { explicit = false } = {}) {
  const wt = worktreeOf(cwd);
  const sid = sessionOf(wt.key, agent);
  const prev = loadRun(ctx.data, sid);
  const quiet = { ...ctx, spawnFlush: () => {} };
  if (prev.startedAt && !prev.ended && !prev.explicit && ctx.now() - (prev.lastCommitAt ?? prev.startedAt) > IDLE_MS) await finish(quiet, cwd, sid);
  const run = await ensureRun({ ...quiet, agent }, { session_id: sid, cwd }, { ...gather(ctx.data, cwd), newSession: true });
  if (!run) return null;
  return withLock(ctx.data, async () => saveRun(ctx.data, sid, { agent, ...(explicit ? { explicit: true } : {}) }), { giveUpMs: LOCK_MS });
}

function remember(data, wtKey, shas) {
  const wt = loadWorktree(data, wtKey);
  const known = new Set(wt.reportedCommits);
  saveWorktree(data, wtKey, { reportedCommits: [...wt.reportedCommits, ...shas.filter((s) => !known.has(s))].slice(-KEEP_COMMITS) });
}

async function postCommit(ctx, cwd) {
  const head = headCommit(cwd);
  if (!head.sha) return 'no commit';
  const wt = worktreeOf(cwd);
  if (pluginLive(cwd, ctx.now())) {
    await withLock(ctx.data, async () => remember(ctx.data, wt.key, [head.sha]), { giveUpMs: LOCK_MS });
    return 'quiet';
  }
  const agent = agentFor(ctx, cwd, head);
  if (!agent) return 'no agent';
  const run = await startRun(ctx, cwd, agent);
  if (!run) return 'no workspace';
  const task = taskFor(ctx, { cwd, session_id: run.sessionId }, budget(HOOK_GIT_MS, ctx.git));
  const repo = repoSlug(cwd);
  const at = ctx.now();
  await withLock(ctx.data, async () => {
    const cur = loadRun(ctx.data, run.sessionId);
    const occurred_at = new Date(at).toISOString();
    const task_key = task(cur);
    append(ctx.data,
      { kind: 'event', sessionId: cur.sessionId, event: { id: eventId('commit', head.sha), type: 'commit', occurred_at, sha: head.sha, subject: head.subject, ...(repo ? { repo } : {}), task_key } },
      // Between commits the run shows idle, not stalled.
      { kind: 'event', sessionId: cur.sessionId, event: { id: eventId('turn', `${cur.clientRunId}:${head.sha}`), type: 'turn', phase: 'ended', occurred_at, task_key } });
    saveRun(ctx.data, cur.sessionId, { lastCommitAt: at, ownCommits: [...new Set([...(cur.ownCommits ?? []), head.sha])].slice(-KEEP_OWN) });
    remember(ctx.data, wt.key, [head.sha]);
  }, { giveUpMs: LOCK_MS });
  (ctx.spawnSync ?? spawnSync)(ctx, cwd);
  return 'queued';
}

async function prePush(ctx, cwd) {
  if (pluginLive(cwd, ctx.now()) || !liveRuns(ctx.data, cwd).length) return 'quiet';
  (ctx.spawnSync ?? spawnSync)(ctx, cwd);
  return 'queued';
}

// A branch switch ends the runs started on another branch; the next commit starts one here.
async function postCheckout(ctx, cwd, [, , branchFlag]) {
  if (branchFlag !== '1') return 'quiet';
  const branch = git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const stale = liveRuns(ctx.data, cwd).filter((r) => !r.explicit && (r.start?.branch ?? '') !== branch);
  for (const r of stale) await finish(ctx, cwd, r.sessionId);
  return stale.length ? 'ended' : 'quiet';
}

const HOOKS = { 'post-commit': postCommit, 'pre-push': prePush, 'post-checkout': postCheckout };

// Never touches the network: queues, then a detached process sends.
export async function runHook(ctx, name, cwd, args = []) {
  const hook = HOOKS[name];
  if (!hook) return 'unknown hook';
  gitTimeout.ms = HOOK_GIT_MS;
  try {
    return await hook(ctx, cwd, args);
  } catch (e) {
    logError(ctx.data, e);
    return 'failed';
  }
}

async function queuePr(ctx, cwd, run) {
  const pr = (ctx.prStatus ?? prStatus)(cwd);
  if (!pr) return false;
  const id = eventId('pull_request', `${pr.action}:${pr.url}`);
  return withLock(ctx.data, async () => {
    const cur = loadRun(ctx.data, run.sessionId);
    if (cur.ended || cur.acked[id]) return false;
    append(ctx.data, { kind: 'event', sessionId: cur.sessionId, event: { id, type: 'pull_request', occurred_at: new Date(ctx.now()).toISOString(), ...pr, repo: pr.url.split('/').slice(3, 5).join('/'), task_key: cur.start?.task ?? null } });
    return true;
  }, { giveUpMs: LOCK_MS });
}

// Plan import, reconcile and the PR check per live CLI run, then a send.
export async function sync(ctx, cwd) {
  if (pluginLive(cwd, ctx.now())) return { quiet: true, runs: 0 };
  const runs = liveRuns(ctx.data, cwd);
  for (const run of runs) {
    await queuePr(ctx, cwd, run).catch((e) => logError(ctx.data, e));
    await reconcileNow({ ...ctx, spawnFlush: () => {} }, { session_id: run.sessionId, cwd }, 'Stop');
  }
  const result = runs.length ? await flush({ data: ctx.data, clientFor: runClient(ctx), harness: 'cli' }) : null;
  return { quiet: false, runs: runs.length, result };
}

export async function stopRuns(ctx, cwd) {
  const runs = liveRuns(ctx.data, cwd);
  for (const r of runs) await finish({ ...ctx, spawnFlush: () => {} }, cwd, r.sessionId);
  if (runs.length) (ctx.spawnFlush ?? spawnFlush)(ctx);
  return runs;
}

export { liveRuns };

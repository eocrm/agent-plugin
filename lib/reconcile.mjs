import { createHash } from 'node:crypto';
import { withLock, git, worktreeOf, loadRun, saveRun, loadWorktree, saveWorktree } from './state.mjs';
import { append, readOutbox } from './outbox.mjs';
import { cleanEvent } from './api.mjs';
import { eventId } from './ids.mjs';
import { activePlan, noteTruncation } from './plans.mjs';
import { branchCommits, budget, prState, repoSlug } from './git.mjs';

const LOCK_MS = 1500;
const KEEP_SEEN = 5000;
const KEEP_COMMITS = 1000;
const KEEP_OWN = 200;
// ponytail: newest 10 open PRs per pass, each a gh call; page through them if a worktree ever holds more.
const PR_CHECKS = 10;
const PR_URL = /^https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)$/;

const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('base64url').slice(0, 22);
const scopeOf = (p) => [p?.source ?? null, p?.path ?? null];

// Server payload identity; a step's plan_key counts only under the plan event before it.
export function identity(type, p, scope) {
  if (type === 'plan') return hash(['plan', ...scopeOf(p), (Array.isArray(p.items) ? p.items : []).map((i) => [i?.key ?? null, i?.text ?? null])]);
  if (type === 'step') return hash(p.plan_key ? ['step', scope, p.plan_key, p.phase ?? null] : ['step', p.label ?? null, p.phase ?? null]);
  if (type === 'commit') return hash(['commit', p.sha ?? null]);
  if (type === 'pull_request') return hash(['pr', p.url ?? null, p.action ?? null]);
  return null;
}

function derive(ctx, run, exec) {
  const plan = activePlan(ctx.cwd, run, exec);
  const wtKey = worktreeOf(ctx.cwd, exec).key;
  const wt = loadWorktree(ctx.data, wtKey);
  const occurred_at = new Date(ctx.now()).toISOString();
  const events = [];
  const add = (type, key, fields, scope = null) => {
    const event = { id: eventId(type, key), type, occurred_at, ...fields };
    events.push({ event, identity: identity(type, cleanEvent(event), scope) });
  };
  const scope = plan && scopeOf(plan);
  const planKey = plan && plan.source + (plan.path ?? '');
  let note = null;
  if (plan && run.conventions?.plan_import === true) {
    add('plan', planKey + JSON.stringify(plan.items), { source: plan.source, ...(plan.path ? { path: plan.path } : {}), items: plan.items });
    for (const item of plan.items) {
      if (plan.done.has(item.key)) add('step', `${planKey}${item.key}:done`, { phase: 'finished', label: item.text, plan_key: item.key }, scope);
    }
    note = noteTruncation(plan, run);
    if (note) add('step', `${planKey}:truncated`, { phase: 'finished', label: note.label });
  }
  for (const r of plan?.rounds ?? []) {
    add('step', `${planKey}:sdd:${r.task}:${r.round}`, { phase: 'finished', label: `Task ${r.task} review round ${r.round}: ${r.summary}` });
  }
  const commits = branchCommits(ctx.cwd, 200, exec);
  if (commits.length) {
    const reported = new Set(wt.reportedCommits);
    // This run's commits are re-derived even when reported: the capped outbox can drop them.
    const mine = new Set([...commits.slice(commits.findIndex((c) => c.sha === run.startHead) + 1).map((c) => c.sha), ...(run.ownCommits ?? [])]);
    const repo = repoSlug(ctx.cwd, git(ctx.cwd, ['remote', 'get-url', 'origin'], exec));
    for (const c of commits) if (!reported.has(c.sha) || mine.has(c.sha)) add('commit', c.sha, { sha: c.sha, subject: c.subject, ...(repo ? { repo } : {}) });
  }
  const merged = [];
  for (const p of wt.openPrs.filter((o) => PR_URL.test(o?.url ?? '')).slice(-PR_CHECKS)) {
    const state = prState(ctx.cwd, p.url, exec);
    if (state === undefined) break;
    if (state !== 'MERGED') continue;
    merged.push(p.url);
    add('pull_request', `merged:${p.url}`, { action: 'merged', url: p.url, number: Number(PR_URL.exec(p.url)[1]), repo: p.url.split('/').slice(3, 5).join('/') });
  }
  return { plan, events, note, merged, wtKey };
}

export const desiredEvents = (ctx, run, exec = budget(10000, ctx.git)) => derive(ctx, run, exec).events.map((e) => e.event);

export function currentStep(plan, run) {
  const todo = (Array.isArray(run.todos) ? run.todos : []).find((t) => t?.status === 'in_progress');
  if (todo) return todo.activeForm || todo.text || null;
  return plan?.items.find((i) => !plan.done.has(i.key))?.text ?? null;
}

export async function loadConventions(ctx, run, client = ctx.clientFor(run)) {
  if (run.conventions) return run.conventions;
  try {
    const { status, body } = await client.conventions();
    if (status !== 200 || !body || typeof body !== 'object') return null;
    await withLock(ctx.data, async () => saveRun(ctx.data, run.sessionId, { conventions: body }), { giveUpMs: LOCK_MS });
    return body;
  } catch {
    return null;
  }
}

async function readServer(client, runId, end) {
  const seen = [];
  let scope = null;
  let cursor;
  do {
    if (Date.now() >= end) return null;
    const { status, body } = await client.listEvents(runId, cursor);
    if (status !== 200 || !Array.isArray(body?.items)) return null;
    for (const e of body.items) {
      const p = e?.payload && typeof e.payload === 'object' ? e.payload : {};
      if (e?.type === 'plan') scope = scopeOf(p);
      const id = identity(e?.type, p, scope);
      if (id) seen.push(id);
    }
    cursor = body.next_cursor;
  } while (cursor);
  return seen;
}

// Pushes desired − acked − serverSeen − pending; repeated with no change it enqueues nothing.
export async function reconcile(ctx, run, { deadlineMs = 10000 } = {}) {
  const { data } = ctx;
  const sid = run.sessionId;
  const end = Date.now() + deadlineMs;
  const client = ctx.clientFor(run);
  const conventions = await loadConventions(ctx, run, client).catch(() => null);
  let seen = null;
  if (!run.serverEventsRead && run.runId) seen = await readServer(client, run.runId, end).catch(() => null);
  if (Date.now() >= end) return { enqueued: 0 };
  const exec = budget(end - Date.now(), ctx.git);
  const startHead = run.startHead ?? (git(ctx.cwd, ['rev-parse', 'HEAD'], exec) || null);
  const { plan, events, note, merged, wtKey } = derive(ctx, { ...run, conventions, startHead }, exec);

  return withLock(data, async () => {
    const cur = loadRun(data, sid);
    if (cur.ended) return { enqueued: 0 };
    const patch = { startHead, planPath: plan?.path ?? null };
    if (seen && cur.runId === run.runId) Object.assign(patch, { serverSeen: seen.slice(-KEEP_SEEN), serverEventsRead: true });
    const server = new Set(patch.serverSeen ?? (cur.serverEventsRead ? cur.serverSeen ?? [] : []));
    const pending = new Set(readOutbox(data).filter((e) => e.sessionId === sid && e.kind === 'event').map((e) => e.event.id));
    const rejected = new Set(cur.rejected.map((r) => r.eventId));
    const send = events.filter((e) => !cur.acked[e.event.id] && !pending.has(e.event.id) && !rejected.has(e.event.id) && !server.has(e.identity));
    const entries = send.map((e) => ({ kind: 'event', sessionId: sid, event: e.event }));
    const label = currentStep(plan, cur);
    const stepKey = label && `${cur.clientRunId}\n${label}`;
    if (stepKey && stepKey !== cur.currentStepKey) {
      entries.push({ kind: 'step', sessionId: sid, step: label });
      patch.currentStepKey = stepKey;
    }
    if (note) Object.assign(patch, note.patch);
    const sentCommits = send.filter((e) => e.event.type === 'commit').map((e) => e.event.sha);
    if (sentCommits.length) patch.ownCommits = [...new Set([...(cur.ownCommits ?? []), ...sentCommits])].slice(-KEEP_OWN);
    if (sentCommits.length || merged.length) {
      const wt = loadWorktree(data, wtKey);
      const known = new Set(wt.reportedCommits);
      saveWorktree(data, wtKey, {
        reportedCommits: [...wt.reportedCommits, ...sentCommits.filter((s) => !known.has(s))].slice(-KEEP_COMMITS),
        openPrs: wt.openPrs.filter((p) => !merged.includes(p?.url)),
      });
    }
    if (entries.length) append(data, ...entries);
    saveRun(data, sid, patch);
    return { enqueued: entries.length };
  }, { giveUpMs: LOCK_MS });
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { reconcile, desiredEvents, currentStep, loadConventions } from '../../lib/reconcile.mjs';
import { cleanEvent } from '../../lib/api.mjs';
import { handle } from '../../lib/run.mjs';
import { readOutbox, writeOutbox } from '../../lib/outbox.mjs';
import { loadRun, saveRun, loadWorktree, saveWorktree, worktreeOf } from '../../lib/state.mjs';
import { eventId } from '../../lib/ids.mjs';

const tmp = (p) => realpathSync.native(mkdtempSync(join(tmpdir(), `eocrm-${p}-`)));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
const PLAN = 'docs/superpowers/plans/p.md';
const PLAN_TEXT = '# P\n\n### Task 1: One\n- [ ] a\n\n### Task 2: Two\n- [ ] b\n\n### Task 3: Three\n- [ ] c\n';
const URL1 = 'https://github.com/o/r/pull/7';

function repo({ ledger = 'Task 1: complete\nTask 2: complete\nTask 3: fix round 1/5 (nit)\n' } = {}) {
  const dir = tmp('repo');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dir, 'checkout', '-q', '-b', 'feat/AB-1-x');
  mkdirSync(join(dir, 'docs/superpowers/plans'), { recursive: true });
  writeFileSync(join(dir, PLAN), PLAN_TEXT);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'plan');
  if (ledger !== null) {
    mkdirSync(join(dir, '.superpowers/sdd/p'), { recursive: true });
    writeFileSync(join(dir, '.superpowers/sdd/p/progress.md'), `# SDD ledger — plan: ${PLAN}\n${ledger}`);
  }
  return dir;
}

let n = 0;
function setup({ planImport = true, server = [], conventions, ledger, gh } = {}) {
  const dir = repo({ ledger });
  const data = tmp('data');
  const sid = `rec-${process.pid}-${++n}`;
  const calls = { conventions: 0, listEvents: 0 };
  const client = {
    conventions: async () => {
      calls.conventions += 1;
      return conventions ? conventions(calls.conventions) : { status: 200, body: { plan_import: planImport } };
    },
    listEvents: async (id, cursor) => {
      calls.listEvents += 1;
      const from = Number(cursor ?? 0);
      return { status: 200, body: { items: server.slice(from, from + 2), next_cursor: from + 2 < server.length ? String(from + 2) : null } };
    },
  };
  const exec = (cmd, args, opts) => (cmd === 'gh' ? gh(args) : execFileSync(cmd, args, opts));
  const ctx = { data, cwd: dir, now: () => 1_000_000, clientFor: () => client, git: gh ? { exec } : undefined };
  saveRun(data, sid, { startedAt: 1, runId: 'r1', clientRunId: sid, workspace: 'acme', region: 'eu' });
  const go = () => reconcile(ctx, loadRun(data, sid));
  const queued = () => readOutbox(data).filter((e) => e.sessionId === sid);
  const evts = () => queued().filter((e) => e.kind === 'event').map((e) => e.event);
  return { dir, data, sid, ctx, calls, go, queued, evts };
}

const tickId = (key) => eventId('step', `superpowers${PLAN}${key}:done`);
const kinds = (evts) => evts.map((e) => (e.plan_key ? `tick:${e.plan_key}` : e.type === 'step' ? `step:${e.label}` : e.type));

test('plan_import on: plan, then its ticks, then SDD rounds, then unreported commits', async () => {
  const { go, evts, queued } = setup();
  assert.equal((await go()).enqueued, 6);
  assert.deepEqual(kinds(evts()), ['plan', 'tick:task-1', 'tick:task-2', 'step:Task 3 review round 1: nit', 'commit']);
  assert.deepEqual(evts()[0].items.map((i) => i.key), ['task-1', 'task-2', 'task-3']);
  assert.equal(evts()[1].id, tickId('task-1'));
  assert.deepEqual(queued().filter((e) => e.kind === 'step').map((e) => e.step), ['3. Three']);
});

test('plan_import false: no plan and no tick events', async () => {
  const { go, evts } = setup({ planImport: false });
  await go();
  assert.deepEqual(kinds(evts()), ['step:Task 3 review round 1: nit', 'commit']);
});

test('a reconcile repeated twice enqueues 0 the second time', async () => {
  const { go } = setup();
  assert.ok((await go()).enqueued > 0);
  assert.equal((await go()).enqueued, 0);
});

test('a done item already acked is not re-sent', async () => {
  const { data, sid, go, evts } = setup();
  await go();
  writeOutbox(data, []);
  saveRun(data, sid, { acked: { [tickId('task-1')]: true } });
  await go();
  assert.deepEqual(kinds(evts()), ['plan', 'tick:task-2', 'step:Task 3 review round 1: nit', 'commit']);
});

test('an event the server rejected is not re-sent', async () => {
  const { data, sid, go, evts } = setup();
  saveRun(data, sid, { rejected: [{ eventId: tickId('task-1'), type: 'step', status: 422, message: 'x' }] });
  await go();
  assert.ok(!kinds(evts()).includes('tick:task-1'));
  assert.ok(kinds(evts()).includes('tick:task-2'));
});

test('a dropped outbox: the next reconcile re-derives the plan, ticks and commits, even reported ones', async () => {
  const { data, sid, dir, go, evts } = setup();
  saveRun(data, sid, { startHead: git(dir, 'rev-parse', 'HEAD~1') });
  await go();
  const first = evts();
  assert.deepEqual(loadWorktree(data, worktreeOf(dir).key).reportedCommits, [git(dir, 'rev-parse', 'HEAD')]);
  writeOutbox(data, []);
  assert.equal((await go()).enqueued, first.length);
  assert.deepEqual(evts().map((e) => e.id), first.map((e) => e.id));
});

test('a commit the detector reported after the run started is re-derived once dropped', async () => {
  const { data, dir, go, evts } = setup({ planImport: false, ledger: null });
  await go();
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'later');
  saveWorktree(data, worktreeOf(dir).key, { reportedCommits: [git(dir, 'rev-parse', 'HEAD~1'), git(dir, 'rev-parse', 'HEAD')] });
  writeOutbox(data, []);
  await go();
  assert.deepEqual(evts().map((e) => e.subject), ['plan', 'later']);
});

test('reported commits from before the run are not re-sent', async () => {
  const { data, dir, go, evts } = setup();
  saveWorktree(data, worktreeOf(dir).key, { reportedCommits: [git(dir, 'rev-parse', 'HEAD')] });
  await go();
  assert.equal(evts().filter((e) => e.type === 'commit').length, 0);
});

test('at resume, events the server already holds are matched by payload identity, not id', async () => {
  const server = [
    { id: 'other-1', type: 'plan', occurred_at: 'x', payload: { source: 'superpowers', path: PLAN, items: [{ key: 'task-1', text: '1. One' }, { key: 'task-2', text: '2. Two' }, { key: 'task-3', text: '3. Three' }] } },
    { id: 'other-2', type: 'step', occurred_at: 'x', payload: { phase: 'finished', label: 'x', plan_key: 'task-1' } },
    { id: 'other-3', type: 'step', occurred_at: 'x', payload: { phase: 'finished', label: 'Task 3 review round 1: nit' } },
  ];
  const { go, evts, calls, data, sid } = setup({ server });
  await go();
  assert.equal(calls.listEvents, 2);
  assert.deepEqual(kinds(evts()), ['tick:task-2', 'commit']);
  assert.equal(loadRun(data, sid).serverEventsRead, true);
  writeOutbox(data, []);
  await go();
  assert.equal(calls.listEvents, 2);
  assert.deepEqual(kinds(evts()), ['tick:task-2', 'commit']);
});

test('a tick seen under another plan does not count for this one', async () => {
  const server = [
    { id: 'a', type: 'plan', occurred_at: 'x', payload: { source: 'markdown', path: 'other.md', items: [{ key: 'task-1', text: 'x' }] } },
    { id: 'b', type: 'step', occurred_at: 'x', payload: { phase: 'finished', plan_key: 'task-1' } },
  ];
  const { go, evts } = setup({ server });
  await go();
  assert.ok(kinds(evts()).includes('tick:task-1'));
});

test('conventions are read once per run and retried after a failure', async () => {
  const { go, evts, calls, data, sid } = setup({ conventions: (i) => (i === 1 ? { status: 503, body: null } : { status: 200, body: { plan_import: true } }) });
  await go();
  assert.ok(!kinds(evts()).includes('plan'));
  await go();
  assert.ok(kinds(evts()).includes('plan'));
  await go();
  assert.equal(calls.conventions, 2);
  assert.deepEqual(loadRun(data, sid).conventions, { plan_import: true });
  assert.deepEqual(await loadConventions({ data }, loadRun(data, sid), { conventions: () => assert.fail('cached') }), { plan_import: true });
});

test('a merged PR gives a merged event and leaves openPrs; an open one stays', async () => {
  const URL2 = 'https://github.com/o/r/pull/8';
  const { go, evts, data, dir } = setup({ planImport: false, ledger: null, gh: (args) => (args.includes(URL1) ? 'MERGED\n' : 'OPEN\n') });
  saveWorktree(data, worktreeOf(dir).key, { openPrs: [{ branch: 'a', url: URL1 }, { branch: 'b', url: URL2 }] });
  await go();
  const prs = evts().filter((e) => e.type === 'pull_request');
  assert.deepEqual(prs.map((e) => [e.action, e.url, e.number, e.repo, e.id]), [['merged', URL1, 7, 'o/r', eventId('pull_request', `merged:${URL1}`)]]);
  assert.deepEqual(loadWorktree(data, worktreeOf(dir).key).openPrs, [{ branch: 'b', url: URL2 }]);
});

test('gh missing: PR checks are skipped and the rest still reconciles', async () => {
  let asked = 0;
  const { go, evts, data, dir } = setup({ planImport: false, ledger: null, gh: () => { asked += 1; throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); } });
  saveWorktree(data, worktreeOf(dir).key, { openPrs: [{ url: URL1 }, { url: 'https://github.com/o/r/pull/8' }] });
  await go();
  assert.equal(asked, 1);
  assert.deepEqual(kinds(evts()), ['commit']);
  assert.equal(loadWorktree(data, worktreeOf(dir).key).openPrs.length, 2);
});

test('the current step is the in-progress todo, else the first item not done, and is queued only on change', async () => {
  const { data, sid, go, queued } = setup();
  const steps = () => queued().filter((e) => e.kind === 'step').map((e) => e.step);
  await go();
  assert.deepEqual(steps(), ['3. Three']);
  writeOutbox(data, []);
  await go();
  assert.deepEqual(steps(), []);
  saveRun(data, sid, { todos: [{ key: 'todo-1', text: 'Fix it', status: 'in_progress', activeForm: 'Fixing it' }] });
  await go();
  assert.deepEqual(steps(), ['Fixing it']);
  writeOutbox(data, []);
  saveRun(data, sid, { clientRunId: `${sid}.1` });
  await go();
  assert.deepEqual(steps(), ['Fixing it']);
  assert.equal(currentStep(null, { todos: [{ status: 'pending', text: 'x' }] }), null);
});

test('desiredEvents is the full set, before the diff', () => {
  const { ctx, data, sid } = setup();
  const types = desiredEvents(ctx, { ...loadRun(data, sid), conventions: { plan_import: true } }).map((e) => e.type);
  assert.deepEqual(types, ['plan', 'step', 'step', 'step', 'commit']);
});

test('a plan switch A→B→A re-sends A under a fresh id, with its new ticks after it', async () => {
  const { data, sid, dir, go, evts } = setup();
  const ledger = join(dir, '.superpowers/sdd/p/progress.md');
  const B = 'docs/superpowers/plans/b.md';
  writeFileSync(join(dir, B), '### Task 1: Bee\n- [ ] x\n');
  const ackAll = () => {
    const run = loadRun(data, sid);
    saveRun(data, sid, { acked: { ...run.acked, ...Object.fromEntries(evts().map((e) => [e.id, true])) } });
    writeOutbox(data, []);
  };
  await go();
  const firstA = evts().find((e) => e.type === 'plan').id;
  ackAll();
  writeFileSync(ledger, `# SDD ledger — plan: ${B}\n`);
  await go();
  assert.deepEqual(evts().filter((e) => e.type === 'plan').map((e) => e.path), [B]);
  ackAll();
  writeFileSync(ledger, `# SDD ledger — plan: ${PLAN}\nTask 1: complete\nTask 2: complete\nTask 3: complete\n`);
  await go();
  const again = evts().filter((e) => e.type === 'plan' || e.plan_key);
  assert.deepEqual(again.map((e) => e.plan_key ?? e.path), [PLAN, 'task-3']);
  assert.notEqual(again[0].id, firstA);
  ackAll();
  await go();
  assert.deepEqual(evts(), []);
});

test('at resume a plan is matched only against the server\'s latest plan', async () => {
  const items = [{ key: 'task-1', text: '1. One' }, { key: 'task-2', text: '2. Two' }, { key: 'task-3', text: '3. Three' }];
  const server = [
    { id: 'a', type: 'plan', occurred_at: 'x', payload: { source: 'superpowers', path: PLAN, items } },
    { id: 'b', type: 'plan', occurred_at: 'x', payload: { source: 'markdown', path: 'b.md', items: [{ key: 'k', text: 't' }] } },
  ];
  const { go, evts } = setup({ server });
  await go();
  assert.equal(kinds(evts())[0], 'plan');
});

test('after the server\'s latest plan is superseded by one we send, switching back re-sends it', async () => {
  const items = [{ key: 'task-1', text: '1. One' }, { key: 'task-2', text: '2. Two' }, { key: 'task-3', text: '3. Three' }];
  const { data, sid, dir, go, evts } = setup({ server: [{ id: 'a', type: 'plan', occurred_at: 'x', payload: { source: 'superpowers', path: PLAN, items } }] });
  const ledger = join(dir, '.superpowers/sdd/p/progress.md');
  const B = 'docs/superpowers/plans/b.md';
  writeFileSync(join(dir, B), '### Task 1: Bee\n- [ ] x\n');
  const ackAll = () => {
    const run = loadRun(data, sid);
    saveRun(data, sid, { acked: { ...run.acked, ...Object.fromEntries(evts().map((e) => [e.id, true])) } });
    writeOutbox(data, []);
  };
  await go();
  assert.ok(!kinds(evts()).includes('plan'));
  ackAll();
  writeFileSync(ledger, `# SDD ledger — plan: ${B}\n`);
  await go();
  ackAll();
  writeFileSync(ledger, `# SDD ledger — plan: ${PLAN}\n`);
  await go();
  assert.deepEqual(evts().filter((e) => e.type === 'plan').map((e) => e.path), [PLAN]);
});

test('a resumed, ended session starts a run that gets none of the earlier run\'s commits', async () => {
  const { dir, data, sid, ctx } = setup({ planImport: false, ledger: null });
  writeFileSync(join(data, 'account.json'), JSON.stringify({ region: 'eu', workspace: 'acme', workspaces: { acme: 'standalone' } }));
  const hctx = { ...ctx, env: {}, spawnFlush: () => {} };
  const s = `${sid}-h`;
  const fire = (event, extra) => handle(event, { session_id: s, cwd: dir, hook_event_name: event, ...extra }, hctx);
  await fire('SessionStart', { source: 'startup' });
  assert.equal(readOutbox(data).filter((e) => e.sessionId === s && e.event?.type === 'commit').length, 1);
  await fire('SessionEnd');
  writeOutbox(data, []);
  await fire('SessionStart', { source: 'resume' });
  assert.equal(loadRun(data, s).generation, 1);
  assert.deepEqual(readOutbox(data).filter((e) => e.sessionId === s && e.event?.type === 'commit'), []);
});

test('a reconcile whose git budget ran out keeps the active plan path', async () => {
  const { data, sid, ctx } = setup();
  saveRun(data, sid, { planPath: PLAN });
  await reconcile({ ...ctx, git: { exec: () => { throw new Error('eocrm: hook budget spent'); } } }, loadRun(data, sid));
  assert.equal(loadRun(data, sid).planPath, PLAN);
});

test('conventions are given up at the deadline, and not asked with under 1s left', async () => {
  let asked = 0;
  const client = { conventions: () => { asked += 1; return new Promise(() => {}); } };
  const t0 = Date.now();
  assert.equal(await loadConventions({}, {}, client, Date.now() + 1100), null);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(await loadConventions({}, {}, client, Date.now() + 500), null);
  assert.equal(asked, 1);
});

test('a plan path is trimmed and capped like the server does', () => {
  assert.equal(cleanEvent({ type: 'plan', path: ' a.md ' }).path, 'a.md');
  assert.ok(cleanEvent({ type: 'plan', path: 'x'.repeat(600) }).path.length <= 500);
});

// Hook wiring: reconcile at run start, at Stop, after plan/ledger/todo changes, else every 5 minutes.
function hooked() {
  const dir = repo();
  const data = tmp('data');
  writeFileSync(join(data, 'account.json'), JSON.stringify({ region: 'eu', workspace: 'acme', workspaces: { acme: 'standalone' } }));
  const ctx = { data, env: { EOCRM_ENDPOINTS: JSON.stringify({ issuer: 'http://127.0.0.1:9', api: 'http://127.0.0.1:9/{workspace}/api' }) }, t: 1_000_000, calls: [] };
  ctx.now = () => ctx.t;
  ctx.spawnFlush = () => {};
  ctx.reconcile = async (c, run) => {
    ctx.calls.push(run.sessionId);
    return { enqueued: 0 };
  };
  const sid = `hk-${process.pid}-${++n}`;
  const fire = (event, extra) => handle(event, { session_id: sid, cwd: dir, hook_event_name: event, ...extra }, ctx);
  return { dir, data, sid, ctx, fire };
}

test('reconcile is throttled to every 5 min from PostToolUse, and runs at start and Stop', async () => {
  const { ctx, fire } = hooked();
  const bash = { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: '' } };
  await fire('SessionStart', { source: 'startup' });
  assert.equal(ctx.calls.length, 1);
  await fire('PostToolUse', bash);
  ctx.t += 299_999;
  await fire('PostToolUse', bash);
  assert.equal(ctx.calls.length, 1);
  ctx.t += 1;
  await fire('PostToolUse', bash);
  assert.equal(ctx.calls.length, 2);
  await fire('Stop', {});
  assert.equal(ctx.calls.length, 3);
});

test('a write to the ledger or the active plan, or a todo change, reconciles at once; other writes are recorded only', async () => {
  const { ctx, data, sid, dir, fire } = hooked();
  await fire('SessionStart', { source: 'startup' });
  saveRun(data, sid, { planPath: PLAN });
  const write = (file) => fire('PostToolUse', { tool_name: 'Write', tool_input: { file_path: join(dir, file) }, tool_response: {} });
  await write('notes.md');
  assert.equal(ctx.calls.length, 1);
  await write(PLAN);
  await write('.superpowers/sdd/p/progress.md');
  assert.equal(ctx.calls.length, 3);
  await fire('PostToolUse', { tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'A', status: 'in_progress', activeForm: 'Doing A' }] } });
  assert.equal(ctx.calls.length, 4);
  const run = loadRun(data, sid);
  assert.deepEqual(run.written, ['notes.md', PLAN, '.superpowers/sdd/p/progress.md'].map((f) => join(dir, f)));
  assert.deepEqual(run.todos.map((t) => [t.text, t.activeForm]), [['A', 'Doing A']]);
});

test('run.written keeps the newest 50, moving a rewritten path to the end', async () => {
  const { data, sid, dir, fire } = hooked();
  await fire('SessionStart', { source: 'startup' });
  for (let i = 0; i < 52; i++) await fire('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: join(dir, `f${i}`) } });
  await fire('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: join(dir, 'f10') } });
  const { written } = loadRun(data, sid);
  assert.equal(written.length, 50);
  assert.equal(written.at(-1), join(dir, 'f10'));
  assert.equal(written[0], join(dir, 'f2'));
});

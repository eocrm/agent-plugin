import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handle, linkContext, ensureRun, linkWorktree, LINK_ASK } from '../../lib/run.mjs';
import { readOutbox, writeOutbox } from '../../lib/outbox.mjs';
import { git as stateGit, loadRun, saveRun, loadWorktree, worktreeOf } from '../../lib/state.mjs';
import { repoSlug } from '../../lib/git.mjs';
import { main } from '../../scripts/eocrm.mjs';
import { flush } from '../../lib/flush.mjs';
import { committedLine } from '../../lib/workspace.mjs';

const DISPATCH = fileURLToPath(new URL('../../hooks/dispatch.mjs', import.meta.url));
const UNREACHABLE = JSON.stringify({ issuer: 'http://127.0.0.1:9', api: 'http://127.0.0.1:9/{workspace}/api' });
const tmp = (p) => realpathSync.native(mkdtempSync(join(tmpdir(), `eocrm-${p}-`)));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });

function repo(branch, origin) {
  const dir = tmp('repo');
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  if (origin) git(dir, 'remote', 'add', 'origin', origin);
  return dir;
}

function signedIn() {
  const data = tmp('data');
  writeFileSync(join(data, 'account.json'), JSON.stringify({ region: 'eu', workspace: 'acme', workspaces: { acme: 'standalone' } }));
  return data;
}

const assistant = (model, extra = {}) => `${JSON.stringify({ type: 'assistant', message: { model, role: 'assistant', content: [] }, ...extra })}\n`;
let sids = 0;
const sid = () => `sess-${process.pid}-${++sids}`;
const input = (session_id, cwd, extra = {}) => ({ session_id, cwd, transcript_path: join(cwd, 'missing.jsonl'), hook_event_name: 'x', ...extra });

function ctxFor(data, at = 1_000_000) {
  const ctx = { data, env: { EOCRM_ENDPOINTS: UNREACHABLE }, now: () => ctx.at, at, spawned: 0 };
  ctx.spawnFlush = () => { ctx.spawned += 1; };
  return ctx;
}

const kinds = (data, session) => readOutbox(data).filter((e) => e.sessionId === session).map((e) => e.kind);
const queued = (data, session) => readOutbox(data).filter((e) => e.sessionId === session).map((e) => e.event?.type ?? e.kind);
const usage = (data) => readOutbox(data).filter((e) => e.event?.type === 'usage').map((e) => e.event);

function hook(event, stdin, { data, env = {}, cwd = process.cwd(), extraArgs = [] } = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(path|claude_plugin_data|eocrm_endpoints)$/i.test(k)));
  const started = Date.now();
  const r = spawnSync(process.execPath, [DISPATCH, event, ...(data ? ['--data', data] : []), ...extraArgs], {
    input: stdin, cwd, encoding: 'utf8', env: { ...base, PATH: process.env.PATH ?? process.env.Path ?? '', EOCRM_ENDPOINTS: UNREACHABLE, ...env }, timeout: 20000,
  });
  return { ...r, ms: Date.now() - started };
}

test('hooks.json declares exactly the planned hooks', () => {
  const { hooks } = JSON.parse(readFileSync(new URL('../../hooks/hooks.json', import.meta.url), 'utf8'));
  const rows = Object.entries(hooks).flatMap(([event, groups]) => groups.map(({ matcher, hooks: [h, ...more] }) => {
    assert.equal(more.length, 0, event);
    assert.deepEqual([h.type, h.command, h.args.slice(0, 1)], ['command', 'node', ['${CLAUDE_PLUGIN_ROOT}/hooks/dispatch.mjs']], event);
    return [event, h.args[1], matcher ?? null, h.async ?? false, h.timeout ?? null];
  }));
  assert.deepEqual(rows, [
    ['SessionStart', 'SessionStart', 'startup|resume|clear|compact|fork', false, 10],
    ['UserPromptSubmit', 'UserPromptSubmit', null, true, null],
    ['UserPromptSubmit', 'Remind', null, false, 5],
    ['PreToolUse', 'PreToolUse', 'Agent|Task', true, null],
    ['PostToolUse', 'PostToolUse', 'Bash|Write|Edit|MultiEdit|TodoWrite|TaskCreate|TaskUpdate|Agent|Task', true, null],
    ['PostToolUse', 'Resume', '*', true, null],
    ['PostToolUse', 'Remind', 'Bash|mcp__.*eocrm.*__tasks_(create|update|move_stage)', false, 5],
    ['PostToolUseFailure', 'PostToolUseFailure', 'Bash', true, null],
    ['Notification', 'Notification', 'permission_prompt|idle_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input', true, null],
    ['Stop', 'Stop', null, false, 30],
    ['SessionEnd', 'SessionEnd', null, false, null],
  ]);
});

test('malformed stdin exits 0 with empty stdout', () => {
  for (const event of ['SessionStart', 'PostToolUse', 'SessionEnd']) {
    const r = hook(event, '{not json', { data: signedIn() });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], event);
  }
});

test('an unwritable --data exits 0 with empty stdout', () => {
  const file = join(tmp('file'), 'plain');
  writeFileSync(file, 'x');
  const r = hook('SessionStart', JSON.stringify(input(sid(), repo('main'))), { data: join(file, 'sub') });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
});

test('git missing from PATH exits 0 with empty stdout and starts without a branch', () => {
  const data = signedIn();
  const s = sid();
  const r = hook('SessionStart', JSON.stringify(input(s, repo('main'))), { data, env: { PATH: tmp('nogit') } });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
  assert.equal(loadRun(data, s).start.branch, undefined);
  assert.deepEqual(kinds(data, s), ['start']);
});

test('SessionStart on a keyed branch prints nothing and starts with branch, worktree and repo, no task', () => {
  const data = signedIn();
  const s = sid();
  const dir = repo('feat/AB-12-x', 'https://user:ghp_FAKEfakeFAKEfakeFAKEfake00@github.com/o/r.git');
  const r = hook('SessionStart', JSON.stringify(input(s, dir, { source: 'startup' })), { data });
  assert.deepEqual([r.status, r.stdout], [0, '']);
  const { start, clientRunId, generation } = loadRun(data, s);
  assert.deepEqual(start, { branch: 'feat/AB-12-x', worktree: worktreeOf(dir).root.split(/[\\/]/).at(-1), repo: 'o/r' });
  assert.deepEqual([clientRunId, generation], [s, 0]);
});

test('SessionStart on main with no link asks once in hookSpecificOutput', () => {
  const data = signedIn();
  const r = hook('SessionStart', JSON.stringify(input(sid(), repo('main'))), { data });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: LINK_ASK } });
  assert.equal(LINK_ASK, 'eocrm: this session isn\'t linked to a task. Ask the member once which task key it is for (or "none"), then use the eocrm link-run skill.');
});

test('a key in the worktree folder name needs no ask', () => {
  assert.equal(linkContext({ taskKey: null, linkAnswered: false }, 'main', join('x', 'AB-7-wt')), null);
  assert.equal(linkContext({ taskKey: null, linkAnswered: false }, 'main', join('x', 'wt')), LINK_ASK);
  assert.equal(linkContext({ taskKey: 'AB-1', linkAnswered: true }, 'main', 'wt'), null);
  assert.equal(linkContext({ taskKey: null, linkAnswered: true }, 'main', 'wt'), null);
  assert.equal(linkContext({ taskKey: null, linkAnswered: false }, 'xAB-12', 'wt'), LINK_ASK);
});

test('a committed workspace that differs is raised once, as one line', async () => {
  const data = signedIn();
  const dir = repo('feat/AB-12-x', 'git@github.com:o/r.git');
  mkdirSync(join(dir, '.claude'));
  writeFileSync(join(dir, '.claude', 'eocrm.json'), JSON.stringify({ workspace: 'other', region: 'eu' }));
  const ctx = ctxFor(data);
  const first = await handle('SessionStart', input(sid(), dir), ctx);
  assert.deepEqual(JSON.parse(first.stdout), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: committedLine({ workspace: 'other', region: 'eu' }) } });
  assert.deepEqual(await handle('SessionStart', input(sid(), dir), ctx), {});
});

test('signed out: nothing queued and nothing printed', () => {
  const data = tmp('data');
  const r = hook('SessionStart', JSON.stringify(input(sid(), repo('main'))), { data });
  assert.deepEqual([r.status, r.stdout], [0, '']);
  assert.deepEqual(readOutbox(data), []);
});

test('after link none the next session prints nothing', async () => {
  const data = signedIn();
  const dir = repo('main');
  const out = [];
  assert.equal(await main({ argv: ['link', 'none', '--data', data], cwd: dir, env: {}, out: (l) => out.push(l), err: () => {} }), 0);
  assert.deepEqual(out, ['not linked to a task', 'Only the default for new sessions changed (no --session).']);
  const r = hook('SessionStart', JSON.stringify(input(sid(), dir)), { data });
  assert.deepEqual([r.status, r.stdout], [0, '']);
});

test('link KEY saves the answer and queues a task update for the live run only', async () => {
  const data = signedIn();
  const dir = repo('main');
  const ctx = ctxFor(data);
  const [live, ended] = [sid(), sid()];
  await handle('SessionStart', input(ended, dir), ctx);
  await handle('SessionEnd', input(ended, dir), ctx);
  await handle('SessionStart', input(live, dir), ctx);
  const out = [];
  const code = await main({ argv: ['link', 'AB-12', '--session', live, '--data', data], cwd: dir, env: ctx.env, out: (l) => out.push(l), err: () => {} });
  assert.equal(code, 0);
  assert.deepEqual(out, ['linked to AB-12']);
  assert.deepEqual(loadWorktree(data, worktreeOf(dir).key).taskKey, 'AB-12');
  assert.deepEqual(readOutbox(data).filter((e) => e.kind === 'task').map((e) => [e.sessionId, e.task]), [[live, 'AB-12']]);
  for (const bad of ['ab-12', 'AB-', 'AB-12 x', '']) {
    assert.equal(await main({ argv: ['link', bad, '--data', data], cwd: dir, env: {}, out: () => {}, err: () => {} }), 2, bad);
  }
});

test('link moves only my run; a later session gets the default', async () => {
  const data = signedIn();
  const dir = repo('main');
  const ctx = ctxFor(data);
  const [a, b, c] = [sid(), sid(), sid()];
  await ensureRun(ctx, input(a, dir));
  await ensureRun(ctx, input(b, dir));
  await linkWorktree(ctx, dir, 'EO-2', a);
  assert.equal(loadRun(data, a).start.task, 'EO-2');
  assert.equal(loadRun(data, b).start.task, undefined);
  await ensureRun(ctx, input(c, dir));
  assert.equal(loadRun(data, c).start.task, 'EO-2');
});

test('a later default doesn\'t move a session that already started', async () => {
  const data = signedIn();
  const dir = repo('main');
  const ctx = ctxFor(data);
  const [a, b] = [sid(), sid()];
  await ensureRun(ctx, input(a, dir));
  await ensureRun(ctx, input(b, dir));
  await linkWorktree(ctx, dir, 'EO-1', a);
  assert.equal((await ensureRun(ctx, input(b, dir, { source: 'compact' }))).start.task, undefined);
  saveRun(data, b, { ended: true, runId: 'r1' });
  const resumed = await ensureRun(ctx, input(b, dir, { source: 'resume' }));
  assert.equal(resumed.generation, 1);
  assert.equal(resumed.start.task, undefined);
  const starts = [];
  const ok = { status: 200, body: {} };
  const client = { startRun: async (body) => { starts.push(body); return { status: 201, body: { id: 'r2' } }; }, recordEvents: async () => ok, heartbeat: async () => ok, updateRun: async () => ok };
  await flush({ data, sessionId: b, clientFor: () => client });
  assert.equal(starts.length, 1);
  assert.equal(starts[0].task, undefined);
});

test('link with no live run of mine relinks nobody', async () => {
  const data = signedIn();
  const dir = repo('main');
  const ctx = ctxFor(data);
  const [a, b] = [sid(), sid()];
  await ensureRun(ctx, input(a, dir));
  await ensureRun(ctx, input(b, dir));
  await linkWorktree(ctx, dir, 'EO-2', 'not-a-live-session');
  assert.deepEqual([loadRun(data, a).start.task, loadRun(data, b).start.task], [undefined, undefined]);
  assert.deepEqual(readOutbox(data).filter((e) => e.kind === 'task'), []);
  assert.equal(loadWorktree(data, worktreeOf(dir).key).taskKey, 'EO-2');
});

test('resume keeps the session\'s own task', async () => {
  const data = signedIn();
  const dir = repo('main');
  const ctx = ctxFor(data);
  const [a, b] = [sid(), sid()];
  await ensureRun(ctx, input(a, dir));
  await linkWorktree(ctx, dir, 'EO-1', a);
  await ensureRun(ctx, input(b, dir));
  await linkWorktree(ctx, dir, 'EO-2', b);
  saveRun(data, a, { ended: true });
  const before = loadRun(data, a).generation;
  const run = await ensureRun(ctx, input(a, dir, { source: 'resume' }));
  assert.equal(run.generation, before + 1);
  assert.equal(run.start.task, 'EO-1');
});

test('link none sticks for my session', async () => {
  const data = signedIn();
  const dir = repo('main');
  const ctx = ctxFor(data);
  const [a, b] = [sid(), sid()];
  await ensureRun(ctx, input(a, dir));
  await ensureRun(ctx, input(b, dir));
  await linkWorktree(ctx, dir, null, a);
  await linkWorktree(ctx, dir, 'EO-2', b);
  assert.equal((await ensureRun(ctx, input(a, dir, { source: 'resume' }))).start.task, undefined);
});

test('link none unfiles my run on the server', async () => {
  const data = signedIn();
  const dir = repo('main');
  const ctx = ctxFor(data);
  const a = sid();
  await ensureRun(ctx, input(a, dir));
  await linkWorktree(ctx, dir, null, a);
  assert.deepEqual(readOutbox(data).filter((e) => e.kind === 'task').map((e) => [e.sessionId, e.task]), [[a, null]]);
  const updates = [];
  const ok = { status: 200, body: {} };
  const client = { startRun: async () => ({ status: 201, body: { id: 'r1' } }), recordEvents: async () => ok, heartbeat: async () => ok, updateRun: async (id, body) => { updates.push([id, body]); return ok; } };
  await flush({ data, sessionId: a, clientFor: () => client });
  assert.deepEqual(updates, [['r1', { task: null }]]);
});

test('link while my run is ended applies on resume', async () => {
  const data = signedIn();
  const dir = repo('main');
  const ctx = ctxFor(data);
  const a = sid();
  await ensureRun(ctx, input(a, dir));
  await linkWorktree(ctx, dir, 'EO-1', a);
  saveRun(data, a, { ended: true });
  await linkWorktree(ctx, dir, 'EO-3', a);
  assert.deepEqual(readOutbox(data).filter((e) => e.kind === 'task').map((e) => e.task), ['EO-1']);
  assert.equal((await ensureRun(ctx, input(a, dir, { source: 'resume' }))).start.task, 'EO-3');
});

test('link reports other active sessions', async () => {
  const data = signedIn();
  const dir = repo('main');
  const ctx = ctxFor(data);
  const [a, b] = [sid(), sid()];
  await ensureRun(ctx, input(a, dir));
  await ensureRun(ctx, input(b, dir));
  await linkWorktree(ctx, dir, 'EO-1', b);
  const link = async (session, d) => {
    const out = [];
    assert.equal(await main({ argv: ['link', 'EO-3', '--session', session, '--data', data], cwd: d, env: ctx.env, out: (l) => out.push(l), err: () => {} }), 0);
    return out;
  };
  assert.ok((await link(a, dir)).includes('Also active here: 1 other session (on EO-1).'));
  const c2 = sid();
  await ensureRun(ctx, input(c2, dir));
  await linkWorktree(ctx, dir, null, c2);
  assert.ok((await link(a, dir)).includes('Also active here: 2 other sessions (on EO-1, none).'));
  const alone = repo('main');
  const c = sid();
  await ensureRun(ctx, input(c, alone));
  assert.deepEqual(await link(c, alone), ['linked to EO-3']);
});

test('a linked worktree starts with its task', async () => {
  const data = signedIn();
  const dir = repo('main');
  await main({ argv: ['link', 'AB-3', '--data', data], cwd: dir, env: {}, out: () => {}, err: () => {} });
  const s = sid();
  assert.deepEqual(await handle('SessionStart', input(s, dir), ctxFor(data)), {});
  assert.equal(loadRun(data, s).start.task, 'AB-3');
});

test('SessionEnd queues finish and returns within 1 s with the server unreachable', () => {
  const data = signedIn();
  const dir = repo('feat/AB-12-x');
  const s = sid();
  hook('SessionStart', JSON.stringify(input(s, dir)), { data });
  const r = hook('SessionEnd', JSON.stringify(input(s, dir, { reason: 'other' })), { data });
  assert.deepEqual([r.status, r.stdout], [0, '']);
  assert.ok(r.ms < 1000, `${r.ms} ms`);
  assert.ok(kinds(data, s).includes('finish'));
});

test('a new session finishes an older still-running run of the same worktree', async () => {
  const data = signedIn();
  const dir = repo('feat/AB-12-x');
  const ctx = ctxFor(data);
  const [old, other, fresh] = [sid(), sid(), sid()];
  const startup = { source: 'startup' };
  await handle('SessionStart', input(old, dir, startup), ctx);
  await handle('SessionStart', input(other, repo('feat/AB-13-y'), startup), ctx);
  await handle('SessionStart', input(fresh, dir, { source: 'resume' }), ctx);
  assert.ok(!kinds(data, old).includes('finish'));
  await handle('SessionStart', input(fresh, dir, startup), ctx);
  assert.ok(kinds(data, old).includes('finish'));
  assert.ok(!kinds(data, other).includes('finish'));
  assert.ok(!kinds(data, fresh).includes('finish'));
  writeOutbox(data, []);
  await handle('SessionStart', input(sid(), dir, { source: 'clear' }), ctx);
  assert.deepEqual([kinds(data, old), kinds(data, fresh)], [[], ['finish']]);
});

test('resume with a pending finish clears it and keeps the generation', async () => {
  const data = signedIn();
  const dir = repo('feat/AB-12-x');
  const ctx = ctxFor(data);
  const s = sid();
  await handle('SessionStart', input(s, dir), ctx);
  saveRun(data, s, { runId: 'r1' });
  writeOutbox(data, readOutbox(data).filter((e) => e.kind !== 'start'));
  await handle('SessionEnd', input(s, dir), ctx);
  assert.deepEqual(kinds(data, s), ['finish']);
  await handle('SessionStart', input(s, dir, { source: 'resume' }), ctx);
  assert.deepEqual(kinds(data, s), []);
  assert.deepEqual([loadRun(data, s).generation, loadRun(data, s).runId, loadRun(data, s).ended], [0, 'r1', false]);
});

test('resume after an acked finish rolls to generation n+1 before queuing anything', async () => {
  const data = signedIn();
  const dir = repo('feat/AB-12-x');
  const ctx = ctxFor(data);
  const s = sid();
  await handle('SessionStart', input(s, dir), ctx);
  saveRun(data, s, { runId: 'r1', acked: { 'commit:x': true } });
  await handle('SessionEnd', input(s, dir), ctx);
  writeOutbox(data, []);
  await handle('UserPromptSubmit', input(s, dir), ctx);
  const run = loadRun(data, s);
  assert.deepEqual([run.generation, run.clientRunId, run.runId, run.ended, run.acked], [1, `${s}.1`, null, false, {}]);
  assert.deepEqual(queued(data, s), ['start', 'turn']);
});

test('a tool hook on an ended run neither reopens nor rolls it', async () => {
  const data = signedIn();
  const dir = repo('feat/AB-12-x');
  const ctx = ctxFor(data);
  const s = sid();
  await handle('SessionStart', input(s, dir), ctx);
  await handle('SessionEnd', input(s, dir), ctx);
  ctx.at += 600_000;
  await handle('PostToolUse', input(s, dir), ctx);
  assert.deepEqual([loadRun(data, s).ended, loadRun(data, s).generation], [true, 0]);
  assert.ok(kinds(data, s).includes('finish'));
  assert.ok(!kinds(data, s).includes('heartbeat'));
});

test('heartbeat is queued from any hook once 120 s have passed', async () => {
  const data = signedIn();
  const dir = repo('feat/AB-12-x');
  const ctx = ctxFor(data);
  const s = sid();
  await handle('SessionStart', input(s, dir), ctx);
  const spawned = ctx.spawned;
  ctx.at += 119_999;
  await handle('PostToolUse', input(s, dir), ctx);
  assert.ok(!kinds(data, s).includes('heartbeat'));
  assert.equal(ctx.spawned, spawned);
  ctx.at += 1;
  await handle('PreToolUse', input(s, dir), ctx);
  assert.ok(kinds(data, s).includes('heartbeat'));
  assert.equal(ctx.spawned, spawned + 1);
  assert.equal(loadRun(data, s).lastHeartbeatAt, ctx.at);
});

test('a hook with no run yet starts one lazily, without printing', async () => {
  const data = signedIn();
  const dir = repo('main');
  const s = sid();
  assert.deepEqual(await handle('Stop', input(s, dir), ctxFor(data)), {});
  assert.deepEqual(queued(data, s), ['start', 'turn']);
});

test('model switches A, B, A in the transcript give exactly three usage events', async () => {
  const data = signedIn();
  const dir = repo('feat/AB-12-x');
  const ctx = ctxFor(data);
  const s = sid();
  const transcript = join(tmp('t'), 't.jsonl');
  const sent = [];
  const fire = async (event) => {
    await handle(event, input(s, dir, { transcript_path: transcript }), ctx);
    sent.push(...usage(data));
    writeOutbox(data, []);
  };
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n${assistant('model-a')}`);
  await fire('SessionStart');
  await fire('PostToolUse');
  appendFileSync(transcript, assistant('model-b'));
  await fire('PostToolUse');
  appendFileSync(transcript, assistant('<synthetic>') + assistant('model-z', { isSidechain: true }));
  await fire('Stop');
  appendFileSync(transcript, assistant('model-a'));
  await fire('PostToolUse');
  await fire('Stop');
  assert.deepEqual(sent.map((e) => e.model), ['model-a', 'model-b', 'model-a']);
  assert.deepEqual(sent.map((e) => e.id.split('-').slice(-2).join('-')), ['0-0', '0-1', '0-2']);
  for (const e of sent) assert.match(e.id, /^model-[A-Za-z0-9_-]{22}-0-\d+$/);
  assert.equal(new Set(sent.map((e) => e.id)).size, 3);
});

test('the model is read from the tail of a large transcript', async () => {
  const data = signedIn();
  const transcript = join(tmp('t'), 't.jsonl');
  writeFileSync(transcript, assistant('model-old') + `${JSON.stringify({ type: 'user', pad: 'x'.repeat(300 * 1024) })}\n` + assistant('model-new'));
  await handle('SessionStart', input(sid(), repo('main'), { transcript_path: transcript }), ctxFor(data));
  assert.deepEqual(usage(data).map((e) => e.model), ['model-new']);
});

test('the transcript model wins over the hook input; input only fills a gap; neither sends nothing', async () => {
  const data = signedIn();
  const dir = repo('feat/AB-12-x');
  const ctx = ctxFor(data);
  const [a, b, c] = [sid(), sid(), sid()];
  await handle('SessionStart', input(a, dir), ctx);
  await handle('PostToolUse', input(a, dir), ctx);
  assert.deepEqual(usage(data), []);
  const transcript = join(tmp('t'), 't.jsonl');
  writeFileSync(transcript, assistant('model-dated'));
  await handle('SessionStart', input(b, dir, { transcript_path: transcript, model: 'model-alias' }), ctx);
  await handle('SessionStart', input(c, dir, { model: 'model-alias' }), ctx);
  assert.deepEqual(usage(data).map((e) => e.model), ['model-dated', 'model-alias']);
});

test('a model id is scrubbed and capped at 100', async () => {
  const data = signedIn();
  const s = sid();
  await handle('SessionStart', input(s, repo('main'), { model: `m-${'x'.repeat(200)}` }), ctxFor(data));
  assert.ok(usage(data)[0].model.length <= 100);
});

test('ensureRun spawns one detached flush and records workspace and region', async () => {
  const data = signedIn();
  const ctx = ctxFor(data);
  const s = sid();
  const run = await ensureRun(ctx, input(s, repo('main')));
  assert.deepEqual([run.workspace, run.region, ctx.spawned], ['acme', 'eu', 1]);
});

test('repoSlug strips credentials and reads scp-style origins', () => {
  assert.equal(repoSlug(repo('main', 'https://user:ghp_FAKEfakeFAKEfakeFAKEfake00@github.com/o/r.git')), 'o/r');
  assert.equal(repoSlug(repo('main', 'git@github.com:o/r.git')), 'o/r');
  assert.equal(repoSlug(repo('main', 'https://git.example.test/team/r.git')), 'git.example.test/team/r');
  assert.equal(repoSlug(repo('main', '../local')), null);
  assert.equal(repoSlug(repo('main')), null);
});

test('repoSlug never carries userinfo, query or fragment', () => {
  const cases = [
    ['https://a@b:tok@host/o/r', 'host/o/r'],
    ['a@b@host:o/r', 'host/o/r'],
    ['host/o/r?sig=XYZ', null],
    ['https://user:ghp_X@github.com/o/r.git', 'o/r'],
    ['ssh://git@host:22/o/r', 'host/o/r'],
    ['https://github.com/o/r#t@x', 'o/r'],
    ['git@github.com:o/r.git', 'o/r'],
    ['git@github.com:o/r?sig=XYZ', null],
    ['C:\\repos\\r', null],
  ];
  for (const [origin, slug] of cases) {
    const got = repoSlug('.', origin);
    assert.equal(got, slug, origin);
    assert.doesNotMatch(String(got), /tok|ghp_|XYZ|a@b|#|@/, origin);
  }
});

test('the dispatcher logs a failure to plugin.log and still prints nothing', () => {
  const data = signedIn();
  const r = hook('SessionStart', JSON.stringify({ session_id: '../evil', cwd: process.cwd() }), { data });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
  assert.match(readFileSync(join(data, 'plugin.log'), 'utf8'), /invalid session id/);
});

test('SessionEnd returns within 1 s even while another hook holds the lock', () => {
  const data = signedIn();
  const dir = repo('main');
  const s = sid();
  hook('SessionStart', JSON.stringify(input(s, dir)), { data });
  // SessionStart's background flush may still hold the lock; wait for it, then hold it ourselves.
  for (const until = Date.now() + 5000; ;) {
    try {
      mkdirSync(join(data, '.lock'));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' || Date.now() > until) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  const r = hook('SessionEnd', JSON.stringify(input(s, dir)), { data });
  assert.deepEqual([r.status, r.stdout], [0, '']);
  assert.ok(r.ms < 1000, `${r.ms} ms`);
});

test('SessionEnd for a session with no run queues nothing', async () => {
  const data = signedIn();
  const ctx = ctxFor(data);
  await handle('SessionEnd', input(sid(), repo('main')), ctx);
  assert.deepEqual([readOutbox(data), ctx.spawned], [[], 0]);
});

test('input without a cwd is refused rather than tracked against the process cwd', async () => {
  const data = signedIn();
  const back = process.cwd();
  process.chdir(repo('main', 'git@github.com:o/r.git'));
  try {
    await assert.rejects(handle('SessionStart', { session_id: sid() }, ctxFor(data)));
  } finally {
    process.chdir(back);
  }
  assert.deepEqual(readOutbox(data), []);
});

test('two live sessions in one worktree do not finish each other on prompts', async () => {
  const data = signedIn();
  const dir = repo('feat/AB-12-x');
  const ctx = ctxFor(data);
  const [a, b] = [sid(), sid()];
  await handle('SessionStart', input(a, dir, { source: 'startup' }), ctx);
  await handle('SessionStart', input(b, dir, { source: 'startup' }), ctx);
  assert.equal(loadRun(data, a).ended, true);
  for (let i = 0; i < 3; i++) {
    await handle('UserPromptSubmit', input(a, dir), ctx);
    await handle('UserPromptSubmit', input(b, dir), ctx);
  }
  assert.deepEqual([a, b].map((x) => [loadRun(data, x).ended, loadRun(data, x).generation]), [[false, 0], [false, 0]]);
  const own = (x) => queued(data, x).filter((k) => k !== 'heartbeat' && k !== 'turn');
  assert.deepEqual([own(a), own(b)], [['start'], ['start']]);
});

test('the committed-workspace ask shows even without a default workspace', async () => {
  const data = tmp('data');
  const dir = repo('main', 'git@github.com:o/r.git');
  mkdirSync(join(dir, '.claude'));
  writeFileSync(join(dir, '.claude', 'eocrm.json'), JSON.stringify({ workspace: 'other', region: 'eu' }));
  const r = await handle('SessionStart', input(sid(), dir), ctxFor(data));
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, committedLine({ workspace: 'other', region: 'eu' }));
  assert.deepEqual(readOutbox(data), []);
});

test('SessionStart gives up on a held lock within its budget', () => {
  const data = signedIn();
  mkdirSync(join(data, '.lock'));
  const r = hook('SessionStart', JSON.stringify(input(sid(), repo('main'))), { data });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: LINK_ASK } });
  assert.ok(r.ms < 3000, `${r.ms} ms`);
});

const posix = process.platform === 'win32' ? { skip: 'POSIX shell fake git' } : {};

test('SessionStart stays inside its 10 s timeout when git hangs', posix, () => {
  const bin = tmp('slowgit');
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nexec sleep 3\n', { mode: 0o755 });
  const data = signedIn();
  const r = hook('SessionStart', JSON.stringify(input(sid(), repo('main'))), { data, env: { PATH: `${bin}:/bin:/usr/bin` } });
  assert.equal(r.status, 0);
  assert.ok(r.ms < 10000, `${r.ms} ms`);
});

test('SessionStart asks git for origin once', posix, () => {
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = tmp('loggit');
  const log = join(bin, 'calls.log');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const data = signedIn();
  const r = hook('SessionStart', JSON.stringify(input(sid(), repo('feat/AB-1-x', 'git@github.com:o/r.git'))), { data, env: { PATH: `${bin}:/bin:/usr/bin` } });
  assert.equal(r.status, 0);
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(calls.filter((c) => c === 'remote get-url origin').length, 1, calls.join('; '));
});

test('git runs with windowsHide', () => {
  let opts;
  stateGit('.', ['status'], (cmd, args, o) => { opts = o; return ''; });
  assert.equal(opts.windowsHide, true);
});

test('a finish spilled while the lock was held is cleared on resume', async () => {
  const data = signedIn();
  const dir = repo('feat/AB-12-x');
  const ctx = ctxFor(data);
  const s = sid();
  await handle('SessionStart', input(s, dir), ctx);
  saveRun(data, s, { runId: 'r1', ended: true });
  writeOutbox(data, []);
  writeFileSync(join(data, 'outbox.1.abcdef.jsonl'), `${JSON.stringify({ kind: 'finish', sessionId: s, seq: 'x' })}\n`);
  await handle('SessionStart', input(s, dir, { source: 'resume' }), ctx);
  assert.deepEqual([loadRun(data, s).generation, loadRun(data, s).ended], [0, false]);
  assert.deepEqual(kinds(data, s), []);
  assert.deepEqual(readdirSync(data).filter((f) => f.startsWith('outbox.1.')), []);
});

test('SessionEnd under a held lock spills its finish for the next hook', async () => {
  const data = signedIn();
  const dir = repo('feat/AB-12-x');
  const ctx = ctxFor(data);
  const s = sid();
  await handle('SessionStart', input(s, dir), ctx);
  mkdirSync(join(data, '.lock'));
  await handle('SessionEnd', input(s, dir), ctx);
  const spilled = readdirSync(data).filter((f) => /^outbox\.\d+\.[0-9a-f]+\.jsonl$/.test(f));
  assert.equal(spilled.length, 1);
  assert.match(readFileSync(join(data, spilled[0]), 'utf8'), /"kind":"finish"/);
});

test('SessionEnd under a held lock leaves no finish for an untracked session', async () => {
  const data = signedIn();
  const dir = repo('feat/AB-12-x');
  mkdirSync(join(data, '.lock'));
  await handle('SessionEnd', input(sid(), dir), ctxFor(data));
  assert.deepEqual(readdirSync(data).filter((f) => /^outbox\.\d+\.[0-9a-f]+\.jsonl$/.test(f)), []);
});

test('SessionStart prunes settled runs idle over 7 days and reads at most 50', async () => {
  const data = signedIn();
  const dir = repo('feat/AB-12-x');
  const ctx = ctxFor(data, Date.now());
  const key = worktreeOf(dir).key;
  const runs = join(data, 'runs');
  const age = (s, days) => { const t = new Date(Date.now() - days * 86400000); utimesSync(join(runs, `${s}.json`), t, t); };
  saveRun(data, 'old-ended', { worktreeKey: key, startedAt: 1, ended: true });
  saveRun(data, 'old-busy', { worktreeKey: key, startedAt: 1, ended: true });
  saveRun(data, 'old-live', { worktreeKey: 'elsewhere', startedAt: 1 });
  saveRun(data, 'buried', { worktreeKey: key, startedAt: 1 });
  writeOutbox(data, [{ kind: 'heartbeat', sessionId: 'old-busy', seq: 'y' }]);
  for (const s of ['old-ended', 'old-busy', 'old-live']) age(s, 8);
  age('buried', 6);
  for (let i = 0; i < 50; i++) saveRun(data, `newer-${i}`, { worktreeKey: 'other', startedAt: 1 });
  await handle('SessionStart', input(sid(), dir, { source: 'startup' }), ctx);
  const left = readdirSync(runs);
  assert.ok(!left.includes('old-ended.json'));
  assert.ok(left.includes('old-busy.json'));
  assert.deepEqual([loadRun(data, 'old-live').ended, kinds(data, 'old-live')], [true, ['finish']]);
  assert.deepEqual([loadRun(data, 'buried').ended, kinds(data, 'buried')], [undefined, []]);
});

test('resuming a session idle over 7 days rolls instead of losing its run', async () => {
  const data = signedIn();
  const dir = repo('feat/AB-12-x');
  const ctx = ctxFor(data, Date.now());
  const s = sid();
  await handle('SessionStart', input(s, dir), ctx);
  saveRun(data, s, { runId: 'r1', ended: true });
  writeOutbox(data, []);
  const t = new Date(Date.now() - 8 * 86400000);
  utimesSync(join(data, 'runs', `${s}.json`), t, t);
  await handle('SessionStart', input(s, dir, { source: 'resume' }), ctx);
  assert.deepEqual([loadRun(data, s).generation, loadRun(data, s).clientRunId], [1, `${s}.1`]);
});

test('a pruned run leaves a generation tombstone, so its resume starts the next generation', async () => {
  const data = signedIn();
  const dir = repo('feat/AB-12-x');
  const ctx = ctxFor(data, Date.now());
  const s = sid();
  await handle('SessionStart', input(s, dir), ctx);
  saveRun(data, s, { runId: 'r1', ended: true, generation: 2 });
  writeOutbox(data, []);
  const t = new Date(Date.now() - 8 * 86400000);
  utimesSync(join(data, 'runs', `${s}.json`), t, t);
  writeFileSync(join(data, 'generations.json'), JSON.stringify({ ancient: { generation: 0, at: Date.now() - 91 * 86400000 } }));
  await handle('SessionStart', input(sid(), dir, { source: 'startup' }), ctx);
  assert.ok(!readdirSync(join(data, 'runs')).includes(`${s}.json`));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(data, 'generations.json'), 'utf8'))), [s]);
  await handle('SessionStart', input(s, dir, { source: 'resume' }), ctx);
  assert.deepEqual([loadRun(data, s).generation, loadRun(data, s).clientRunId], [3, `${s}.3`]);
});

test('SessionStart keeps an 8 s overall deadline when the lock is held after ensureRun', async () => {
  const data = signedIn();
  const dir = repo('feat/AB-1-x', 'git@github.com:o/r.git');
  const ctx = ctxFor(data);
  // A slow start, then a flush that holds the lock: tick's wait must shrink to what is left.
  ctx.spawnFlush = () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 7500);
    mkdirSync(join(data, '.lock'));
  };
  const started = Date.now();
  assert.deepEqual(await handle('SessionStart', input(sid(), dir, { source: 'startup' }), ctx), {});
  const took = Date.now() - started;
  assert.ok(took < 8500, `took ${took} ms`);
});

test('it does not recount history after a tombstoned resume', async () => {
  const data = signedIn();
  const cwd = repo('main');
  const s = sid();
  const p = join(cwd, 'old.jsonl');
  const row = (id, n) => `${JSON.stringify({ type: 'assistant', message: { id, model: 'a', usage: { input_tokens: n, output_tokens: 1 } } })}\n`;
  writeFileSync(p, row('old', 5));
  writeFileSync(join(data, 'generations.json'), JSON.stringify({ [s]: { generation: 0, at: Date.now() } }));
  const ctx = ctxFor(data);
  await handle('SessionStart', input(s, cwd, { source: 'resume', transcript_path: p }), ctx);
  appendFileSync(p, row('new', 2));
  await handle('UserPromptSubmit', input(s, cwd, { transcript_path: p }), ctx);
  await handle('Stop', input(s, cwd, { transcript_path: p }), ctx);
  const counted = readOutbox(data).filter((e) => e.event?.cache_read_tokens !== undefined).map((e) => e.event.input_tokens);
  assert.deepEqual(counted, [2]);
});

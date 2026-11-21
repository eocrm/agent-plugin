import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseOpenSpec, parseMarkdown, activePlan, MAX_ITEMS } from '../../lib/plans.mjs';
import { reconcile } from '../../lib/reconcile.mjs';
import { readOutbox } from '../../lib/outbox.mjs';
import { loadRun, saveRun } from '../../lib/state.mjs';
import { repoEntry, updateRepo } from '../../lib/workspace.mjs';
import { credentialStore } from '../../lib/credentials.mjs';
import { endpoints } from '../../lib/endpoints.mjs';
import { main } from '../../scripts/eocrm.mjs';
import { openChanges } from '../../lib/cli/openspec.mjs';
import { startFixtureServer } from '../support/fixture-server.mjs';

const fx = (name) => readFileSync(new URL(`../fixtures/openspec/${name}`, import.meta.url), 'utf8');
const tmp = (p) => realpathSync.native(mkdtempSync(join(tmpdir(), `eocrm-${p}-`)));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
const put = (root, rel, text) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const TASKS = (id) => `openspec/changes/${id}/tasks.md`;

function repo(branch = 'feat') {
  const dir = tmp('repo');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'remote', 'add', 'origin', 'git@github.com:acme/app.git');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dir, 'checkout', '-q', '-b', branch);
  return dir;
}

const MIXED = [
  '# Tasks',
  '## 1. Group',
  '- [ ] 1.1 Dash',
  '* [x] 1.2 Star',
  '+ [X] 1.3. Plus',
  '1. [~] 1.4 Numbered bullet, in progress',
  '   - [ ] 1.4.1 Nested',
  '- [ ] No number here',
  '- [ ] 2 Single number',
  '```md',
  '- [ ] 9.9 Fenced',
  '```',
  '~~~',
  '- [x] 9.8 Tilde fenced',
  '~~~',
  '- [ ] 1.5 After the fences',
  '',
].join('\n');

test('parseOpenSpec: a real tasks.md keys items by their N.M and N.M.K numbers', () => {
  const { items, done } = parseOpenSpec(fx('add-list-command/tasks.md'));
  assert.deepEqual(items.slice(0, 3), [
    { key: '1.1', text: 'Create `src/core/list.ts` with list logic' },
    { key: '1.1.1', text: 'Implement directory scanning (exclude archive/)' },
    { key: '1.1.2', text: 'Implement task counting from tasks.md files' },
  ]);
  assert.deepEqual(items.map((i) => i.key).slice(-7), ['3.1', '3.1.1', '3.1.2', '3.1.3', '3.1.4', '4.1', '4.2']);
  assert.equal(items.length, 17);
  assert.equal(done.size, 17);
});

test('parseOpenSpec: bullets, [~] open, unnumbered and single numbers hash, fenced lines ignored, keys stable', () => {
  const { items, done } = parseOpenSpec(MIXED);
  const hash = (body) => parseMarkdown(`- [ ] ${body}`).items[0].key;
  assert.deepEqual(items, [
    { key: '1.1', text: 'Dash' },
    { key: '1.2', text: 'Star' },
    { key: '1.3', text: 'Plus' },
    { key: '1.4', text: 'Numbered bullet, in progress' },
    { key: '1.4.1', text: 'Nested' },
    { key: hash('No number here'), text: 'No number here' },
    { key: hash('2 Single number'), text: '2 Single number' },
    { key: '1.5', text: 'After the fences' },
  ]);
  assert.deepEqual([...done], ['1.2', '1.3']);
  const shifted = parseOpenSpec(MIXED.replace('## 1. Group', '## 1. Group\n- [ ] Inserted first'));
  assert.deepEqual(shifted.items.slice(1).map((i) => i.key), items.map((i) => i.key));
});

test('parseOpenSpec: the current unnumbered template falls back to hash keys', () => {
  const { items, done } = parseOpenSpec(fx('install-skills-globally/tasks.md'));
  assert.ok(items.length > 0 && items.every((i) => /^md-[0-9a-f]{12}$/.test(i.key)));
  assert.equal(done.size, items.length);
});

test('activePlan: an open change on the branch is an openspec plan; archive/ is not a change', () => {
  const dir = repo();
  put(dir, TASKS('add-list-command'), fx('add-list-command/tasks.md').replaceAll('[x]', '[ ]'));
  put(dir, 'openspec/changes/archive/tasks.md', '- [ ] 1.1 not a change\n');
  const p = activePlan(dir, {});
  assert.equal(p.source, 'openspec');
  assert.equal(p.path, TASKS('add-list-command'));
  assert.equal(p.change, 'add-list-command');
  assert.equal(p.items[0].key, '1.1');
  assert.equal(p.done.size, 0);
});

test('activePlan: an archived change reports its plan complete under the original path', () => {
  const dir = repo();
  put(dir, TASKS('foo'), '- [x] 1.1 a\n- [ ] 1.2 b\n- [ ] untitled\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'foo');
  mkdirSync(join(dir, 'openspec/changes/archive'));
  renameSync(join(dir, 'openspec/changes/foo'), join(dir, 'openspec/changes/archive/2026-11-20-foo'));
  let p = activePlan(dir, {});
  assert.equal(p.path, TASKS('foo'));
  assert.equal(p.change, 'foo');
  assert.deepEqual([...p.done].sort(), p.items.map((i) => i.key).sort());
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'archive foo');
  put(dir, TASKS('2026-01-01-bar'), '- [ ] 1.1 c\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'bar');
  renameSync(join(dir, 'openspec/changes/2026-01-01-bar'), join(dir, 'openspec/changes/archive/2026-01-01-bar'));
  utimesSync(join(dir, 'openspec/changes/archive/2026-01-01-bar/tasks.md'), new Date(2030, 0, 1), new Date(2030, 0, 1));
  p = activePlan(dir, {});
  assert.equal(p.path, TASKS('2026-01-01-bar'));
  assert.deepEqual([...p.done], ['1.1']);
});

let n = 0;
function reconciling(dir, { repos, env } = {}) {
  const data = tmp('data');
  if (repos) updateRepo(data, dir, repos);
  const sid = `os-${process.pid}-${++n}`;
  const client = { conventions: async () => ({ status: 200, body: { plan_import: true } }), listEvents: async () => ({ status: 200, body: { items: [], next_cursor: null } }) };
  const ctx = { data, cwd: dir, now: () => 1_000_000, clientFor: () => client, ...(env ? { env } : {}) };
  saveRun(data, sid, { startedAt: 1, runId: 'r1', clientRunId: sid, workspace: 'acme', region: 'eu', start: {} });
  const go = () => reconcile(ctx, loadRun(data, sid));
  const queued = () => readOutbox(data).filter((e) => e.sessionId === sid);
  return { data, sid, go, queued };
}

test('a plugin session reconciles an OpenSpec change as an openspec plan with numbered ticks', async () => {
  const dir = repo();
  put(dir, TASKS('foo'), '- [x] 1.1 a\n- [ ] 1.2 b\n');
  const { go, queued } = reconciling(dir);
  await go();
  const events = queued().filter((e) => e.kind === 'event').map((e) => e.event);
  assert.deepEqual(events[0].items, [{ key: '1.1', text: 'a' }, { key: '1.2', text: 'b' }]);
  assert.equal(events[0].source, 'openspec');
  assert.equal(events[0].path, TASKS('foo'));
  assert.deepEqual(events.filter((e) => e.plan_key).map((e) => e.plan_key), ['1.1']);
});

async function taskOf(dir, opts) {
  const { go, queued } = reconciling(dir, opts);
  await go();
  const plan = queued().find((e) => e.event?.type === 'plan');
  return { event: plan.event.task_key, run: queued().filter((e) => e.kind === 'task').map((e) => e.task) };
}

test('linking: branch key, then the proposal comment, then the per-remote mapping', async () => {
  const dir = repo();
  put(dir, TASKS('foo'), '- [ ] 1.1 a\n');
  assert.deepEqual(await taskOf(dir), { event: null, run: [] });
  const repos = { openspec: { foo: 'AB-9' } };
  assert.deepEqual(await taskOf(dir, { repos }), { event: 'AB-9', run: ['AB-9'] });
  put(dir, 'openspec/changes/foo/proposal.md', '# Foo\n\n## Why\n\nBecause.\n\n<!-- eocrm: AB-7 -->\n');
  assert.deepEqual(await taskOf(dir, { repos }), { event: 'AB-7', run: ['AB-7'] });
  git(dir, 'checkout', '-q', '-b', 'AB-1-x');
  assert.deepEqual(await taskOf(dir, { repos }), { event: 'AB-1', run: [] });
});

test('a CLI commit on main reports the mapped change\'s plan, ticks and task', async () => {
  const dir = repo();
  git(dir, 'checkout', '-q', 'main');
  put(dir, TASKS('foo'), '- [ ] 1.1 a\n- [ ] 1.2 b\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'change');
  put(dir, TASKS('foo'), '- [x] 1.1 a\n- [ ] 1.2 b\n');
  git(dir, 'commit', '-q', '-am', 'tick');
  const { data, sid, go, queued } = reconciling(dir, { repos: { openspec: { foo: 'AB-9' } } });
  saveRun(data, sid, { ownCommits: [git(dir, 'rev-parse', 'HEAD')] });
  await go();
  const events = queued().filter((e) => e.kind === 'event').map((e) => e.event);
  assert.equal(events.find((e) => e.type === 'plan')?.path, TASKS('foo'));
  assert.deepEqual(events.filter((e) => e.plan_key).map((e) => [e.plan_key, e.task_key]), [['1.1', 'AB-9']]);
  assert.deepEqual(queued().filter((e) => e.kind === 'task').map((e) => e.task), ['AB-9']);
});

test('a plugin session links through the mapping the CLI wrote in its own data dir, reading it only', async () => {
  const dir = repo();
  put(dir, TASKS('foo'), '- [ ] 1.1 a\n');
  const xdg = tmp('xdg');
  const cli = join(xdg, 'eocrm');
  updateRepo(cli, dir, { openspec: { foo: 'AB-4' } });
  const before = readFileSync(join(cli, 'repos.json'), 'utf8');
  assert.deepEqual(await taskOf(dir, { env: { XDG_DATA_HOME: xdg } }), { event: 'AB-4', run: ['AB-4'] });
  assert.deepEqual(await taskOf(dir, { env: { XDG_DATA_HOME: xdg }, repos: { openspec: { foo: 'AB-8' } } }), { event: 'AB-8', run: ['AB-8'] });
  assert.equal(readFileSync(join(cli, 'repos.json'), 'utf8'), before);
});

async function nextChange(dir, opts, bar = '- [x] 1.1 b\n- [ ] 1.2 c\n') {
  put(dir, TASKS('foo'), '- [x] 1.1 a\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'foo');
  const r = reconciling(dir, opts);
  await r.go();
  put(dir, TASKS('bar'), bar);
  utimesSync(join(dir, TASKS('bar')), new Date(2030, 0, 1), new Date(2030, 0, 1));
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'bar');
  await r.go();
  return r;
}
const plans = (queued) => queued().filter((e) => e.event?.type === 'plan').map((e) => [e.event.path, e.event.task_key]);
const ticks = (queued) => queued().filter((e) => e.event?.plan_key).map((e) => [e.event.plan_key, e.event.task_key]);

test('a change not yet imported holds its plan instead of landing on the previous change\'s task', async () => {
  const dir = repo();
  const { data, sid, go, queued } = await nextChange(dir, { repos: { openspec: { foo: 'AB-9' } } });
  assert.deepEqual(plans(queued), [[TASKS('foo'), 'AB-9']]);
  assert.deepEqual(ticks(queued), [['1.1', 'AB-9']]);
  assert.ok(queued().some((e) => e.event?.type === 'commit' && e.event.task_key === 'AB-9'));
  updateRepo(data, dir, { openspec: { foo: 'AB-9', bar: 'AB-10' } });
  await go();
  assert.deepEqual(plans(queued), [[TASKS('foo'), 'AB-9'], [TASKS('bar'), 'AB-10']]);
  assert.deepEqual(ticks(queued), [['1.1', 'AB-9'], ['1.1', 'AB-10']]);
  assert.equal(queued().filter((e) => e.kind === 'task').at(-1).task, 'AB-10');
  assert.equal(loadRun(data, sid).start.task, 'AB-10');
  assert.equal((await go()).enqueued, 0);
});

test('a hand-linked task still gets a change not yet imported', async () => {
  const dir = repo();
  put(dir, TASKS('bar'), '- [ ] 1.1 b\n');
  const { data, sid, go, queued } = reconciling(dir);
  saveRun(data, sid, { start: { task: 'AB-3' } });
  await go();
  assert.deepEqual(plans(queued), [[TASKS('bar'), 'AB-3']]);
});

test('a task linked by hand after a mapping set it still gets a change not yet imported', async () => {
  const dir = repo();
  const { data, sid, queued, go } = await nextChange(dir, { repos: { openspec: { foo: 'AB-9' } } });
  saveRun(data, sid, { start: { ...loadRun(data, sid).start, task: 'AB-3' } });
  await go();
  assert.deepEqual(plans(queued).at(-1), [TASKS('bar'), 'AB-3']);
});

test('a branch task key after a mapping still gets a change not yet imported', async () => {
  const dir = repo();
  const { go, queued } = await nextChange(dir, { repos: { openspec: { foo: 'AB-9' } } });
  git(dir, 'checkout', '-q', '-b', 'AB-1-y');
  await go();
  assert.deepEqual(plans(queued).at(-1), [TASKS('bar'), 'AB-1']);
});

test('a superpowers plan after a mapped change still goes to that change\'s task', async () => {
  const dir = repo();
  put(dir, TASKS('foo'), '- [ ] 1.1 a\n');
  const { go, queued } = reconciling(dir, { repos: { openspec: { foo: 'AB-9' } } });
  await go();
  put(dir, 'docs/superpowers/plans/p.md', '# P\n\n### Task 1: One\n- [ ] a\n');
  utimesSync(join(dir, 'docs/superpowers/plans/p.md'), new Date(2030, 0, 1), new Date(2030, 0, 1));
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'p');
  await go();
  assert.deepEqual(plans(queued).at(-1), ['docs/superpowers/plans/p.md', 'AB-9']);
});

test('a held change keeps its truncation note until it is imported', async () => {
  const dir = repo();
  const many = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => `- [ ] 1.${i + 1} t${i}\n`).join('');
  const { data, go, queued } = await nextChange(dir, { repos: { openspec: { foo: 'AB-9' } } }, many);
  updateRepo(data, dir, { openspec: { foo: 'AB-9', bar: 'AB-10' } });
  await go();
  assert.equal(queued().find((e) => /truncated/.test(e.event?.label ?? ''))?.event.task_key, 'AB-10');
});

test('a branch with a superpowers plan and an OpenSpec change reports the newer one', () => {
  const dir = repo();
  put(dir, 'docs/superpowers/plans/p.md', '### Task 1: A\n- [ ] s\n');
  put(dir, TASKS('foo'), '- [ ] 1.1 a\n');
  const at = (rel, y) => utimesSync(join(dir, rel), new Date(y, 0, 1), new Date(y, 0, 1));
  at('docs/superpowers/plans/p.md', 2020);
  at(TASKS('foo'), 2021);
  assert.equal(activePlan(dir, {}).source, 'openspec');
  at('docs/superpowers/plans/p.md', 2022);
  assert.equal(activePlan(dir, {}).source, 'superpowers');
});

async function importer(t, { responses } = {}) {
  const server = await startFixtureServer({ responses });
  t.after(() => server.close());
  const dir = repo();
  put(dir, TASKS('add-list-command'), fx('add-list-command/tasks.md'));
  put(dir, 'openspec/changes/add-list-command/proposal.md', fx('add-list-command/proposal.md'));
  put(dir, TASKS('install-skills-globally'), fx('install-skills-globally/tasks.md'));
  put(dir, 'openspec/changes/install-skills-globally/proposal.md', fx('install-skills-globally/proposal.md'));
  put(dir, TASKS('linked'), '- [ ] 1.1 a\n');
  put(dir, 'openspec/changes/linked/proposal.md', '<!-- eocrm: AB-3 -->\n## Why\n\nx\n');
  put(dir, 'openspec/changes/archive/2026-01-01-old/tasks.md', '- [ ] 1.1 old\n');
  const xdg = tmp('xdg');
  const data = join(xdg, 'eocrm');
  mkdirSync(data);
  writeFileSync(join(data, 'account.json'), JSON.stringify({ region: 'eu', workspace: 'acme', workspaces: { acme: 'standalone' } }));
  const store = credentialStore({ data, platform: 'none' });
  await store.set(endpoints({ region: 'eu', env: server.endpointsEnv }).key, { access_token: server.auth.access, refresh_token: server.auth.refresh, client_id: server.auth.clientId });
  const env = { ...server.endpointsEnv, XDG_DATA_HOME: xdg };
  const cli = async (...argv) => {
    const out = [];
    const err = [];
    const code = await main({ argv, cwd: dir, env, store, out: (l) => out.push(l), err: (l) => err.push(l), harness: 'cli' });
    return { code, out, err };
  };
  const imports = () => server.requests.filter((r) => r.path === '/v1/agent-work/tasks');
  return { server, dir, data, cli, imports };
}

test('openspec import without --space lists the spaces and exits 2', async (t) => {
  const { cli, imports } = await importer(t);
  const r = await cli('openspec', 'import');
  assert.equal(r.code, 2);
  assert.ok(r.out.includes('space EO Engineering'));
  assert.match(r.err.join('\n'), /--space/);
  assert.equal(imports().length, 0);
});

test('openspec import creates one task per unlinked open change, remembers it, and a re-run is a no-op', async (t) => {
  const { cli, imports, data, dir } = await importer(t);
  const r = await cli('openspec', 'import', '--space', 'EO');
  assert.equal(r.code, 0, r.err.join('\n'));
  const sent = imports().map((q) => q.body);
  assert.deepEqual(sent.map((b) => b.plan.path).sort(), [TASKS('add-list-command'), TASKS('install-skills-globally')]);
  const list = sent.find((b) => b.plan.path === TASKS('add-list-command'));
  assert.equal(list.title, 'Add List Command to OpenSpec CLI');
  assert.equal(list.space, 'EO');
  assert.equal(list.plan.source, 'openspec');
  assert.equal(list.plan.items[1].key, '1.1.1');
  assert.match(list.description, /^## Why\n\nDevelopers need visibility/);
  assert.doesNotMatch(list.description, /What Changes/);
  assert.match(list.client_ref, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(sent), /acme\/app/);
  assert.equal(sent.find((b) => b.plan.path === TASKS('install-skills-globally')).title, 'install-skills-globally');
  const mapping = repoEntry(data, dir).openspec;
  assert.deepEqual(Object.keys(mapping).sort(), ['add-list-command', 'install-skills-globally']);
  const again = await cli('openspec', 'import', '--space', 'EO');
  assert.equal(again.code, 0);
  assert.equal(imports().length, 2);
  updateRepo(data, dir, { openspec: {} });
  await cli('openspec', 'import', '--space', 'EO');
  assert.deepEqual(imports().slice(2).map((q) => q.response.key), sent.map((_, i) => imports()[i].response.key));
  assert.deepEqual(imports().slice(2).map((q) => q.status), [200, 200]);
});

test('openspec import reports a plan another member owns and carries on', async (t) => {
  const { cli, data, dir } = await importer(t, {
    responses: { 'agentWorkTasks.store': ({ body }) => (body.plan.path === TASKS('add-list-command') ? { status: 422, body: { message: 'taken', code: 'plan_on_other_task', errors: { plan: ['taken'] } } } : undefined) },
  });
  const r = await cli('openspec', 'import', '--space', 'EO');
  assert.equal(r.code, 0);
  assert.ok(r.out.some((l) => /add-list-command: .*another task \(taken\)/.test(l)));
  assert.deepEqual(Object.keys(repoEntry(data, dir).openspec), ['install-skills-globally']);
});

test('openspec import still fails when a real error sits beside a plan already on a task', async (t) => {
  const { cli } = await importer(t, {
    responses: { 'agentWorkTasks.store': ({ body }) => (body.plan.path === TASKS('add-list-command') ? { status: 422, body: { message: 'taken', code: 'plan_on_other_task', errors: { plan: ['taken'] } } } : { status: 500, body: { message: 'boom' } }) },
  });
  const r = await cli('openspec', 'import', '--space', 'EO');
  assert.equal(r.code, 1);
  assert.ok(r.out.some((l) => /install-skills-globally: not imported \(HTTP 500/.test(l)));
});

test('eocrm link <change> <KEY> maps a change; none removes it', async (t) => {
  const { cli, data, dir } = await importer(t);
  assert.equal((await cli('link', 'add-list-command', 'AB-5')).code, 0);
  assert.deepEqual(repoEntry(data, dir).openspec, { 'add-list-command': 'AB-5' });
  assert.equal((await cli('link', 'add-list-command', 'none')).code, 0);
  assert.deepEqual(repoEntry(data, dir).openspec, {});
  assert.equal((await cli('link', '../x', 'AB-5')).code, 2);
});

test('symlinks leading outside the repo are never read: tasks.md, proposal.md, a change dir or openspec/changes', async (t) => {
  const outside = tmp('outside');
  put(outside, 'secret/tasks.md', '- [ ] 1.1 SECRET-TASK\n');
  put(outside, 'secret/proposal.md', '# SECRET-TITLE\n\n## Why\n\nSECRET-WHY\n');
  put(outside, 'changes/stolen/tasks.md', '- [ ] 1.1 SECRET-TASK\n');
  const { cli, imports, dir } = await importer(t);
  mkdirSync(join(dir, 'openspec/changes/linked-file'));
  symlinkSync(join(outside, 'secret/tasks.md'), join(dir, TASKS('linked-file')));
  rmSync(join(dir, 'openspec/changes/add-list-command/proposal.md'));
  symlinkSync(join(outside, 'secret/proposal.md'), join(dir, 'openspec/changes/add-list-command/proposal.md'));
  symlinkSync(join(outside, 'secret'), join(dir, 'openspec/changes/linked-dir'));
  put(dir, '.env', '- [ ] 1.1 SECRET-IN-REPO\n');
  mkdirSync(join(dir, 'openspec/changes/linked-env'));
  symlinkSync(join(dir, '.env'), join(dir, TASKS('linked-env')));
  const r = await cli('openspec', 'import', '--space', 'EO');
  assert.equal(r.code, 1);
  for (const id of ['linked-dir', 'linked-env', 'linked-file']) assert.ok(r.out.includes(`${id}: unreadable, skipped`), id);
  const again = await cli('openspec', 'import', '--space', 'EO');
  assert.equal(again.code, 1);
  assert.ok(again.out.includes('nothing else to import'));
  assert.ok(!again.out.some((l) => /every open change is linked/.test(l)));
  const sent = JSON.stringify(imports().map((q) => q.body));
  assert.doesNotMatch(sent, /SECRET/);
  assert.equal(imports().find((q) => q.body.plan.path === TASKS('add-list-command')).body.title, 'add-list-command');
  assert.ok(!imports().some((q) => /linked-/.test(q.body.plan.path)));

  const linked = repo();
  mkdirSync(join(linked, 'openspec'));
  symlinkSync(join(outside, 'changes'), join(linked, 'openspec/changes'), 'dir');
  assert.deepEqual(openChanges(linked), [{ id: 'stolen', unreadable: true }]);
  assert.equal(activePlan(linked, {}), null);
  const other = repo();
  mkdirSync(join(other, 'openspec/changes/foo'), { recursive: true });
  symlinkSync(join(outside, 'secret/tasks.md'), join(other, TASKS('foo')));
  assert.equal(activePlan(other, {}), null);
  const env = repo();
  put(env, '.env', '- [ ] 1.1 SECRET-IN-REPO\n');
  mkdirSync(join(env, 'openspec/changes/foo'), { recursive: true });
  symlinkSync(join(env, '.env'), join(env, TASKS('foo')));
  assert.equal(activePlan(env, {}), null);
});

test('openspec import says when a plan is cut at MAX_ITEMS', async (t) => {
  const { cli } = await importer(t);
  const r = await cli('openspec', 'import', '--space', 'EO');
  assert.ok(!r.out.some((l) => /truncated/.test(l)));
  const { cli: cli2, dir } = await importer(t);
  put(dir, TASKS('big'), Array.from({ length: MAX_ITEMS + 1 }, (_, i) => `- [ ] 1.${i + 1} item\n`).join(''));
  const big = await cli2('openspec', 'import', '--space', 'EO');
  assert.ok(big.out.includes(`big: plan truncated at ${MAX_ITEMS} items`));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseOpenSpec, parseMarkdown, activePlan } from '../../lib/plans.mjs';
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
function reconciling(dir, { repos } = {}) {
  const data = tmp('data');
  if (repos) updateRepo(data, dir, repos);
  const sid = `os-${process.pid}-${++n}`;
  const client = { conventions: async () => ({ status: 200, body: { plan_import: true } }), listEvents: async () => ({ status: 200, body: { items: [], next_cursor: null } }) };
  const ctx = { data, cwd: dir, now: () => 1_000_000, clientFor: () => client };
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

const taskOf = async (dir, opts) => {
  const { go, queued } = reconciling(dir, opts);
  await go();
  const plan = queued().find((e) => e.event?.type === 'plan');
  return { event: plan.event.task_key, run: queued().filter((e) => e.kind === 'task').map((e) => e.task) };
};

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
  assert.equal(r.code, 1);
  assert.ok(r.out.some((l) => /add-list-command: .*another task/.test(l)));
  assert.deepEqual(Object.keys(repoEntry(data, dir).openspec), ['install-skills-globally']);
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
  assert.equal((await cli('openspec', 'import', '--space', 'EO')).code, 0);
  const sent = JSON.stringify(imports().map((q) => q.body));
  assert.doesNotMatch(sent, /SECRET/);
  assert.equal(imports().find((q) => q.body.plan.path === TASKS('add-list-command')).body.title, 'add-list-command');
  assert.ok(!imports().some((q) => /linked-/.test(q.body.plan.path)));

  const linked = repo();
  mkdirSync(join(linked, 'openspec'));
  symlinkSync(join(outside, 'changes'), join(linked, 'openspec/changes'), 'dir');
  assert.deepEqual(openChanges(linked), []);
  assert.equal(activePlan(linked, {}), null);
  const other = repo();
  mkdirSync(join(other, 'openspec/changes/foo'), { recursive: true });
  symlinkSync(join(outside, 'secret/tasks.md'), join(other, TASKS('foo')));
  assert.equal(activePlan(other, {}), null);
});

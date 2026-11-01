import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseSuperpowers, parseMarkdown, parseTodos, parseLedger, activePlan, relPath, noteTruncation, MAX_ITEMS } from '../../lib/plans.mjs';

const fixture = (name) => readFileSync(new URL(`../fixtures/plans/${name}`, import.meta.url), 'utf8');
const tmp = () => realpathSync.native(mkdtempSync(join(tmpdir(), 'eocrm-plans-')));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
const put = (root, rel, text, mtime) => {
  const file = join(root, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
  if (mtime) utimesSync(file, mtime, mtime);
  return file;
};
const PLAN = (n, title = 'T') => `### Task ${n}: ${title}\n- [x] step\n`;

function repo() {
  const dir = tmp();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dir, 'checkout', '-q', '-b', 'feat');
  return dir;
}

test('parseSuperpowers: one item per Task heading; done needs ≥1 step and all [x]', () => {
  const { items, done } = parseSuperpowers(fixture('three-tasks.md'));
  assert.deepEqual(items, [
    { key: 'task-1', text: '1. Scaffold' },
    { key: 'task-2', text: '2. Parser' },
    { key: 'task-3', text: '3. No steps yet' },
  ]);
  assert.deepEqual([...done], ['task-1']);
});

test('the CRLF fixture parses identically', () => {
  assert.ok(fixture('three-tasks-crlf.md').includes('\r\n'));
  assert.deepEqual(parseSuperpowers(fixture('three-tasks-crlf.md')), parseSuperpowers(fixture('three-tasks.md')));
  assert.deepEqual(parseMarkdown(fixture('three-tasks-crlf.md')), parseMarkdown(fixture('three-tasks.md')));
});

test('parseMarkdown: sha256 keys, repeats suffixed, x and X are done', () => {
  const { items, done } = parseMarkdown('- [ ] Ship it\n  * [X]   Ship   it \n- [x] other\n- [ ] Ship it\nnot - [ ] this\n');
  const base = items[0].key;
  assert.match(base, /^md-[0-9a-f]{12}$/);
  assert.deepEqual(items.map((i) => i.key), [base, `${base}-2`, items[2].key, `${base}-3`]);
  assert.deepEqual(items.map((i) => i.text), ['Ship it', 'Ship it', 'other', 'Ship it']);
  assert.deepEqual([...done], [`${base}-2`, items[2].key]);
});

test('parseTodos: TodoWrite replaces the list; done when completed', () => {
  const { items, done, todos } = parseTodos({
    tool_name: 'TodoWrite',
    tool_input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress', activeForm: 'Doing b' }, { content: 'a', status: 'pending' }] },
  });
  assert.match(items[0].key, /^todo-[0-9a-f]{12}$/);
  assert.equal(items[2].key, `${items[0].key}-2`);
  assert.deepEqual([...done], [items[0].key]);
  assert.equal(todos[1].activeForm, 'Doing b');
});

test('parseTodos: TaskCreate/TaskUpdate keep state across calls by task id', () => {
  let { todos } = parseTodos({ tool_name: 'TaskCreate', tool_input: { subject: 'first' }, tool_response: { task: { id: '1', subject: 'first' } } });
  ({ todos } = parseTodos({ tool_name: 'TaskCreate', tool_input: { subject: 'second' }, tool_response: { task: { id: '2' } } }, todos));
  const r = parseTodos({ tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'completed' } }, todos);
  assert.deepEqual(r.items, [{ key: 'todo-1', text: 'first' }, { key: 'todo-2', text: 'second' }]);
  assert.deepEqual([...r.done], ['todo-1']);
  const gone = parseTodos({ tool_name: 'TaskUpdate', tool_input: { taskId: '2', status: 'deleted' } }, r.todos);
  assert.deepEqual(gone.items.map((i) => i.key), ['todo-1']);
  const bad = parseTodos({ tool_name: 'TaskCreate', tool_input: { subject: 'x' }, tool_response: { task: { id: 'a b/c' } } }, gone.todos);
  assert.deepEqual(bad.todos, gone.todos);
});

test('parseLedger: plan path, completes and rounds', () => {
  const l = parseLedger('# SDD ledger — plan: docs/superpowers/plans/p.md\r\nTask 1: DONE abc\r\nTask 2: complete 5da7ee7 (x)\r\nTask 3: fix round 2/5 (scrubber (nested) leak)\r\nnote Task 4: complete\r\n');
  assert.equal(l.plan, 'docs/superpowers/plans/p.md');
  assert.ok(l.complete.has(2));
  assert.ok(!l.complete.has(1) && !l.complete.has(4));
  assert.deepEqual(l.rounds, [{ task: 3, round: 2, summary: 'scrubber (nested) leak' }]);
  assert.equal(parseLedger('# something else\nTask 1: complete').plan, '');
});

test('relPath: Windows session path under a Windows root is repo-relative with /', () => {
  assert.equal(relPath('C:\\r', 'C:\\r\\docs\\superpowers\\plans\\x.md'), 'docs/superpowers/plans/x.md');
  assert.equal(relPath('c:\\R', 'C:\\r\\a.md'), 'a.md');
  assert.equal(relPath('/r', '/r/docs/../a.md'), 'a.md');
  assert.equal(relPath('/r', 'docs/a.md'), 'docs/a.md');
  assert.equal(relPath('/r', '/other/a.md'), null);
  assert.equal(relPath('C:\\r', 'D:\\r\\a.md'), null);
});

test('more than 200 items: the first 200, flagged truncated, noted once per run', () => {
  const text = Array.from({ length: 205 }, (_, i) => `- [x] item ${i}`).join('\n');
  const p = parseMarkdown(text);
  assert.equal(MAX_ITEMS, 200);
  assert.equal(p.items.length, 200);
  assert.equal(p.items.at(-1).text, 'item 199');
  assert.equal(p.done.size, 200);
  assert.equal(p.truncated, true);
  assert.equal(parseMarkdown('- [ ] a').truncated, false);
  assert.equal(parseMarkdown(Array.from({ length: 200 }, (_, i) => `- [ ] ${i}`).join('\n')).truncated, false);
  assert.equal(parseSuperpowers(Array.from({ length: 201 }, (_, i) => PLAN(i + 1)).join('')).items.length, 200);
  const note = noteTruncation(p, {});
  assert.deepEqual(note, { label: 'plan truncated at 200 items', patch: { planTruncatedNoted: true } });
  assert.equal(noteTruncation(p, note.patch), null);
  assert.equal(noteTruncation(parseMarkdown('- [ ] a'), {}), null);
});

test('activePlan: the ledger plan wins over a newer plan file; ledger complete counts as done', () => {
  const dir = repo();
  put(dir, 'docs/superpowers/plans/old.md', PLAN(1) + '### Task 2: B\n- [ ] s\n', new Date(2020, 0, 1));
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'old');
  put(dir, 'docs/superpowers/plans/new.md', PLAN(1, 'Newer'));
  put(dir, '.superpowers/sdd/x/progress.md', '# SDD ledger — plan: docs/superpowers/plans/old.md\nTask 2: complete\n');
  const p = activePlan(dir, {});
  assert.equal(p.source, 'superpowers');
  assert.equal(p.path, 'docs/superpowers/plans/old.md');
  assert.deepEqual(p.items.map((i) => i.key), ['task-1', 'task-2']);
  assert.deepEqual([...p.done].sort(), ['task-1', 'task-2']);
});

test('activePlan: superpowers step-done counts only at HEAD', () => {
  const dir = repo();
  put(dir, 'docs/superpowers/plans/p.md', '### Task 1: A\n- [ ] s\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'plan');
  put(dir, 'docs/superpowers/plans/p.md', '### Task 1: A\n- [x] s\n');
  assert.deepEqual([...activePlan(dir, {}).done], []);
  git(dir, 'commit', '-q', '-am', 'tick');
  assert.deepEqual([...activePlan(dir, {}).done], ['task-1']);
});

test('activePlan: newest branch plan file, untracked included, then session writes, then todos', () => {
  const dir = repo();
  put(dir, 'docs/superpowers/plans/main.md', '- [ ] on main\n');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'main plan');
  git(dir, 'checkout', '-q', 'feat');
  git(dir, 'merge', '-q', 'main');
  const todos = parseTodos({ tool_name: 'TodoWrite', tool_input: { todos: [{ content: 't', status: 'completed' }] } }).todos;
  const notes = put(dir, 'notes/todo.md', '- [ ] from session\n');
  const older = put(dir, 'notes/older.md', '- [ ] older\n');
  put(dir, 'notes/plain.md', 'no boxes\n');
  put(dir, 'notes/closed.md', '- [x] all ticked\n');
  const run = { written: [older, notes, join(dir, 'notes/plain.md'), join(dir, 'notes/closed.md'), '/elsewhere/x.md'], todos };
  assert.deepEqual(activePlan(dir, run), { source: 'markdown', path: 'notes/todo.md', items: parseMarkdown('- [ ] from session').items, done: new Set(), truncated: false });
  assert.equal(activePlan(dir, { todos }).source, 'todo');
  assert.deepEqual([...activePlan(dir, { todos }).done], [todos[0].key]);
  put(dir, 'docs/superpowers/plans/a.md', '- [ ] a\n', new Date(2020, 0, 1));
  put(dir, 'docs/superpowers/plans/b.md', '- [x] b\n', new Date(2021, 0, 1));
  const p = activePlan(dir, run);
  assert.equal(p.path, 'docs/superpowers/plans/b.md');
  assert.equal(p.source, 'markdown');
  assert.equal(activePlan(dir, {}).path, 'docs/superpowers/plans/b.md');
  git(dir, 'add', 'docs');
  git(dir, 'commit', '-q', '-m', 'plans');
  assert.equal(activePlan(dir, {}).path, 'docs/superpowers/plans/b.md');
  assert.equal(activePlan(tmp(), {}), null);
});

test('activePlan: a session-written file with Task headings is superpowers', () => {
  const dir = repo();
  const f = put(dir, 'x/plan.md', '### Task 1: A\n- [ ] s\n');
  assert.deepEqual(activePlan(dir, { written: [f] }).items, [{ key: 'task-1', text: '1. A' }]);
  assert.equal(activePlan(dir, { written: [f] }).source, 'superpowers');
});

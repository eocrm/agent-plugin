import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { git, worktreeOf } from './state.mjs';
import { mergeBase, reached as reachedFrom } from './git.mjs';
import { clean } from './scrub.mjs';

export const MAX_ITEMS = 200;
const ITEM_TEXT = 500;
const MAX_FILE = 1024 * 1024;
const TASK = /^### Task (\d+):\s*(.+)$/;
const HEADING = /^#{1,3} /;
const BOX = /^\s*[-*] \[( |x|X)\] (.+)$/;
const OPEN_BOX = /^\s*[-*] \[ \] ./;
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const LEDGER = /^# SDD ledger — plan: (.+)$/;
const COMPLETE = /^Task (\d+): complete\b/;
const ROUND = /^Task (\d+): fix round (\d+)\/5 \((.*)\)/;
const TASK_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const PLANS_DIR = 'docs/superpowers/plans';
const PLAN_FILE = /^docs\/superpowers\/plans\/[^/]+\.md$/;
const CHANGES_DIR = 'openspec/changes';
const CHANGE = /^openspec\/changes\/(?!archive\/tasks\.md$)(archive\/)?([^/]+)\/tasks\.md$/;
const OS_BOX = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX~])\]\s+(.*)$/;
const OS_KEY = /^(\d+(?:\.\d+)+)\.?\s+(\S.*)$/;
const DATED = /^\d{4}-\d{2}-\d{2}-(.+)$/;
const CHANGE_DIR = /^(openspec\/changes\/(?:archive\/)?[^/]+)\//;
export const LINK = /<!--\s*eocrm:\s*([A-Z][A-Z0-9]{1,9}-[0-9]+)\s*-->/;
const WIN = /^(?:[A-Za-z]:|\\\\)/;
// Session paths follow the cwd's own shape, not the host's.
export const pathFor = (dir) => (WIN.test(dir) ? win32 : posix);

const lines = (text) => String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
// Lines outside ``` / ~~~ fences; a fence closes on the same char, at least as long, nothing after.
function outside(text) {
  const out = [];
  let open = null;
  for (const line of lines(text)) {
    const f = FENCE.exec(line);
    if (open) {
      if (f && f[1][0] === open[0] && f[1].length >= open.length && !f[2].trim()) open = null;
    } else if (f) open = f[1];
    else out.push(line);
  }
  return out;
}
const norm = (text) => text.trim().replace(/\s+/g, ' ');
const hex = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

function finish(entries) {
  const seen = new Map();
  const items = [];
  const done = new Set();
  for (const e of entries.slice(0, MAX_ITEMS)) {
    const n = (seen.get(e.key) ?? 0) + 1;
    seen.set(e.key, n);
    const key = n > 1 ? `${e.key}-${n}` : e.key;
    items.push({ key, text: clean(e.text, ITEM_TEXT) });
    if (e.done) done.add(key);
  }
  return { items, done, truncated: entries.length > MAX_ITEMS };
}

export function parseSuperpowers(text) {
  const tasks = [];
  let task = null;
  for (const line of outside(text)) {
    const m = TASK.exec(line);
    if (m) tasks.push((task = { key: `task-${m[1]}`, text: `${m[1]}. ${m[2].trim()}`, steps: 0, ticked: 0 }));
    else if (HEADING.test(line)) task = null;
    else if (task) {
      const box = BOX.exec(line);
      if (box) {
        task.steps++;
        if (box[1] !== ' ') task.ticked++;
      }
    }
  }
  return finish(tasks.map((t) => ({ ...t, done: t.steps > 0 && t.ticked === t.steps })));
}

export function parseMarkdown(text) {
  return finish(outside(text).flatMap((line) => {
    const m = BOX.exec(line);
    const body = m && norm(m[2]);
    return body ? [{ key: `md-${hex(body)}`, text: body, done: m[1] !== ' ' }] : [];
  }));
}

export function parseOpenSpec(text) {
  return finish(outside(text).flatMap((line) => {
    const m = OS_BOX.exec(line);
    const body = m && norm(m[2]);
    if (!body) return [];
    const k = OS_KEY.exec(body);
    return [{ key: k ? k[1] : `md-${hex(body)}`, text: k ? k[2] : body, done: m[1] === 'x' || m[1] === 'X' }];
  }));
}

export const changeTasks = (id) => `${CHANGES_DIR}/${id}/tasks.md`;

const fromTodos = (todos) => finish(todos.map((t) => ({ key: t.key, text: t.text, done: t.status === 'completed' })));

// input is the PostToolUse hook input; prev is run.todos, and the returned todos replace it.
export function parseTodos(input, prev = []) {
  let todos = Array.isArray(prev) ? prev : [];
  const ti = input?.tool_input ?? {};
  const form = (t) => (typeof t.activeForm === 'string' ? { activeForm: clean(t.activeForm, ITEM_TEXT) } : {});
  if (input?.tool_name === 'TodoWrite' && Array.isArray(ti.todos)) {
    todos = ti.todos.filter((t) => typeof t?.content === 'string' && norm(t.content)).map((t) => ({
      key: `todo-${hex(norm(t.content))}`, text: norm(t.content), status: t.status, ...form(t),
    }));
  } else if (input?.tool_name === 'TaskCreate') {
    const id = String(input.tool_response?.task?.id ?? '');
    const subject = typeof ti.subject === 'string' ? norm(ti.subject) : '';
    if (TASK_ID.test(id) && subject) todos = [...todos.filter((t) => t.key !== `todo-${id}`), { key: `todo-${id}`, text: subject, status: 'pending', ...form(ti) }];
  } else if (input?.tool_name === 'TaskUpdate') {
    const key = `todo-${ti.taskId}`;
    if (ti.status === 'deleted') todos = todos.filter((t) => t.key !== key);
    else {
      todos = todos.map((t) => (t.key !== key ? t : {
        ...t,
        ...(typeof ti.subject === 'string' && norm(ti.subject) ? { text: norm(ti.subject) } : {}),
        ...(typeof ti.status === 'string' ? { status: ti.status } : {}),
        ...form(ti),
      }));
    }
  }
  return { ...fromTodos(todos), todos };
}

export function parseLedger(text) {
  const all = lines(text);
  const complete = new Set();
  const rounds = [];
  for (const line of all) {
    const c = COMPLETE.exec(line);
    if (c) complete.add(Number(c[1]));
    const r = ROUND.exec(line);
    if (r) rounds.push({ task: Number(r[1]), round: Number(r[2]), summary: clean(r[3], 200) });
  }
  return { plan: LEDGER.exec(all[0])?.[1].trim() ?? '', complete, rounds };
}

export function relPath(root, file) {
  const p = pathFor(root);
  const base = p.resolve(root);
  const rel = p.relative(base, p.resolve(base, file));
  if (!rel || rel === '..' || rel.startsWith(`..${p.sep}`) || p.isAbsolute(rel)) return null;
  return rel.split(p.sep).join('/');
}

export function noteTruncation(plan, run) {
  return plan?.truncated && !run?.planTruncatedNoted ? { label: `plan truncated at ${MAX_ITEMS} items`, patch: { planTruncatedNoted: true } } : null;
}

// Symlinks may not lead a read outside the repo, nor outside dir.
export function read(root, file, dir = root) {
  try {
    const real = realpathSync.native(file);
    if (relPath(realpathSync.native(root), real) === null || relPath(realpathSync.native(dir), real) === null) return null;
    return statSync(file).size > MAX_FILE ? null : readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const mtime = (file) => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return -1;
  }
};

// Superpowers steps count as done only at HEAD (Ruling 8); ledger completes always do.
export const readChange = (root, rel) => read(root, join(root, rel), join(root, CHANGES_DIR));
const readPlan = (root, rel) => (CHANGE.test(rel) ? readChange(root, rel) : read(root, join(root, rel)));

function load(root, rel, pass, complete = new Set(), text = readPlan(root, rel)) {
  const { exec } = pass;
  if (text === null) return null;
  const change = CHANGE.exec(rel);
  if (change) return openSpec(root, rel, change, text, pass);
  if (!outside(text).some((l) => TASK.test(l))) {
    const plan = parseMarkdown(text);
    return plan.items.length ? { source: 'markdown', path: rel, ...plan } : null;
  }
  const plan = parseSuperpowers(text);
  const keys = new Set(plan.items.map((i) => i.key));
  const atHead = parseSuperpowers(git(root, ['show', `HEAD:${rel}`], exec)).done;
  const done = new Set([...atHead, ...[...complete].map((n) => `task-${n}`)].filter((k) => keys.has(k)));
  return { source: 'superpowers', path: rel, ...plan, done };
}

// OpenSpec keeps a dated id as is when archiving, so a dated folder is the id only if the branch or its base had it.
function changeOf(root, dir, { exec, base }) {
  const bare = DATED.exec(dir)?.[1];
  if (!bare) return dir;
  const path = changeTasks(dir);
  const had = git(root, ['ls-tree', '--name-only', base(), '--', path], exec) || git(root, ['rev-list', '-1', `${base()}..HEAD`, '--', path], exec);
  return had ? dir : bare;
}

// An archived change is done, reported under its original path so the server keeps one plan.
function openSpec(root, rel, [, archived, dir], text, pass) {
  const plan = parseOpenSpec(text);
  if (!plan.items.length) return null;
  const change = archived ? changeOf(root, dir, pass) : dir;
  const link = LINK.exec(readChange(root, `${rel.slice(0, -'tasks.md'.length)}proposal.md`) ?? '')?.[1] ?? null;
  const done = archived ? new Set(plan.items.map((i) => i.key)) : plan.done;
  return { source: 'openspec', path: changeTasks(change), change, link, ...plan, done };
}

function fromLedger(root, pass) {
  const dir = join(root, '.superpowers', 'sdd');
  let ledgers;
  try {
    ledgers = readdirSync(dir).map((d) => join(dir, d, 'progress.md')).filter((f) => mtime(f) >= 0).sort((a, b) => mtime(b) - mtime(a));
  } catch {
    return null;
  }
  for (const f of ledgers) {
    const { plan, complete, rounds } = parseLedger(read(root, f));
    const rel = plan && relPath(root, plan);
    const found = rel && load(root, rel, pass, complete);
    if (found) return { ...found, rounds };
  }
  return null;
}

// On the default branch the branch diff is empty: the run's own commits HEAD reaches name its plan, any file of a change its tasks.md.
function fromCommits(root, base, shas, exec) {
  if (!Array.isArray(shas) || !shas.length || (base !== 'HEAD' && base !== git(root, ['rev-parse', 'HEAD'], exec))) return [];
  const reached = reachedFrom(root, shas, exec);
  if (!reached.length) return [];
  return git(root, ['log', '--ignore-missing', '--no-walk=unsorted', '--name-only', '-z', '--format=', ...reached, '--', PLANS_DIR, CHANGES_DIR], exec)
    .split('\0').map((n) => {
      const dir = CHANGE_DIR.exec(n)?.[1];
      return dir ? `${dir}/tasks.md` : n;
    });
}

function fromBranch(root, pass, own) {
  const { exec } = pass;
  const base = pass.base();
  const names = [
    ...git(root, ['diff', '--name-only', '-z', '--diff-filter=d', base, '--', PLANS_DIR, CHANGES_DIR], exec).split('\0'),
    ...git(root, ['ls-files', '-z', '--others', '--exclude-standard', '--', PLANS_DIR, CHANGES_DIR], exec).split('\0'),
    ...fromCommits(root, base, own, exec),
  ].filter((n) => PLAN_FILE.test(n) || CHANGE.test(n));
  const files = [...new Set(names)].sort((a, b) => mtime(join(root, b)) - mtime(join(root, a)));
  for (const rel of files) {
    const found = load(root, rel, pass);
    if (found) return found;
  }
  return null;
}

function fromWritten(root, written, pass) {
  const paths = Array.isArray(written) ? written.filter((f) => typeof f === 'string') : [];
  for (const f of [...new Set(paths)].reverse()) {
    const rel = relPath(root, f);
    if (!rel || !/\.md$/i.test(rel)) continue;
    const text = readPlan(root, rel);
    const found = text !== null && outside(text).some((l) => OPEN_BOX.test(l)) && load(root, rel, pass, undefined, text);
    if (found) return found;
  }
  return null;
}

// run.written: Write/Edit file_paths the session made, oldest first; run.todos: parseTodos state.
export function activePlan(cwd, run = {}, exec) {
  const { root } = worktreeOf(cwd, exec);
  const todos = Array.isArray(run?.todos) && run.todos.length ? { source: 'todo', ...fromTodos(run.todos) } : null;
  let base;
  const pass = { exec, base: () => (base ??= mergeBase(root, exec) ?? 'HEAD') };
  return fromLedger(root, pass) ?? fromBranch(root, pass, run?.ownCommits) ?? fromWritten(root, run?.written, pass) ?? todos;
}

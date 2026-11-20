import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { worktreeOf } from '../state.mjs';
import { LINK, MAX_ITEMS, changeTasks, parseOpenSpec, readChange } from '../plans.mjs';
import { repoEntry, repoKey, updateRepo } from '../workspace.mjs';
import { plain } from '../login.mjs';

const FENCE = /^\s*(`{3,}|~{3,})/;
const TITLE = /^# (.+)$/;
const SECTION = /^## /;
const WHY = /^## why\s*$/i;
export const CHANGE_ID = /^\w[\w.-]*$/;

// Sections by `## ` heading, fenced lines kept but never split on.
function sections(text) {
  const out = [{ heading: null, lines: [] }];
  let fence = null;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const f = FENCE.exec(line);
    if (f) fence = fence === null ? f[1][0] : fence === f[1][0] ? null : fence;
    if (fence === null && !f && SECTION.test(line)) out.push({ heading: line, lines: [line] });
    else out.at(-1).lines.push(line);
  }
  return out;
}

export function proposalOf(text, id) {
  const all = sections(text ?? '');
  const title = all[0].lines.map((l) => TITLE.exec(l)?.[1]).find(Boolean)?.trim() || id;
  const why = all.find((s) => WHY.test(s.heading ?? '')) ?? all[1];
  return { title, description: why ? why.lines.join('\n').trim() : null, link: LINK.exec(text ?? '')?.[1] ?? null };
}

export function openChanges(root) {
  let dirs;
  try {
    dirs = readdirSync(join(root, 'openspec', 'changes'), { withFileTypes: true });
  } catch {
    return [];
  }
  const exists = (rel) => {
    try {
      return Boolean(lstatSync(join(root, rel)));
    } catch {
      return false;
    }
  };
  return dirs.filter((d) => (d.isDirectory() || d.isSymbolicLink()) && d.name !== 'archive' && CHANGE_ID.test(d.name)).flatMap((d) => {
    const tasks = readChange(root, changeTasks(d.name));
    if (tasks === null) return exists(changeTasks(d.name)) ? [{ id: d.name, unreadable: true }] : [];
    return [{ id: d.name, tasks, ...proposalOf(readChange(root, `openspec/changes/${d.name}/proposal.md`), d.name) }];
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export const linkChange = (data, cwd, id, key) => {
  const mapping = { ...repoEntry(data, cwd).openspec };
  if (key) mapping[id] = key;
  else delete mapping[id];
  updateRepo(data, cwd, { openspec: mapping });
};

// The ref is a hash, so the remote never leaves the machine.
const clientRef = (cwd, id) => createHash('sha256').update(`${repoKey(cwd)}#${id}`).digest('hex');

export async function importChanges({ client, data, cwd, space, out }) {
  const mapped = repoEntry(data, cwd).openspec ?? {};
  const open = openChanges(worktreeOf(cwd).root).filter((c) => !c.link && !mapped[c.id]);
  const unreadable = open.filter((c) => c.unreadable);
  for (const c of unreadable) out(`${c.id}: unreadable, skipped`);
  const todo = open.filter((c) => !c.unreadable);
  if (!todo.length) {
    out(unreadable.length ? 'nothing else to import' : 'nothing to import: every open change is linked');
    return unreadable.length ? 1 : 0;
  }
  if (!space) {
    const res = await client.conventions();
    const spaces = res.status === 200 && Array.isArray(res.body?.spaces) ? res.body.spaces : null;
    if (!spaces) throw Object.assign(new Error(`spaces unavailable (HTTP ${res.status})`), { exitCode: 3 });
    for (const s of spaces) out(`space ${plain(s.key)} ${plain(s.name)}`);
    throw Object.assign(new Error('choose a space: eocrm openspec import --space <KEY>'), { exitCode: 2 });
  }
  let failed = unreadable.length;
  for (const c of todo) {
    const { items, truncated } = parseOpenSpec(c.tasks);
    if (truncated) out(`${c.id}: plan truncated at ${MAX_ITEMS} items`);
    if (!items.length) {
      out(`${c.id}: no tasks, skipped`);
      continue;
    }
    const res = await client.importTask({ client_ref: clientRef(cwd, c.id), space, title: c.title, description: c.description, plan: { source: 'openspec', path: changeTasks(c.id), items } });
    if ((res.status === 200 || res.status === 201) && res.body?.key) {
      linkChange(data, cwd, c.id, res.body.key);
      out(`${c.id}: ${plain(res.body.key)}`);
    } else {
      failed++;
      out(`${c.id}: ${res.body?.code === 'plan_on_other_task' ? `already on another task${res.body?.message ? ` (${plain(res.body.message)})` : ''}` : `not imported (HTTP ${res.status}${res.body?.message ? `: ${plain(res.body.message)}` : ''})`}`);
    }
  }
  return failed ? 1 : 0;
}

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { withLock, readJson, writeJsonAtomic, writeFileAtomic, remove, LockTimeout } from './state.mjs';
import { cleanEvent } from './api.mjs';
import { clean, LIMITS } from './scrub.mjs';

export const MAX_ENTRIES = 2000;
export const MAX_SPILLS = 50;

const file = (data) => join(data, 'outbox.jsonl');
const SPILL = /^outbox\.\d+\.[0-9a-f]+\.jsonl$/;
const LIFECYCLE = new Set(['start', 'finish']);

function parse(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line);
      return entry && typeof entry === 'object' && typeof entry.sessionId === 'string' ? [entry] : [];
    } catch {
      return [];
    }
  });
}

export const readOutbox = (data) => parse(file(data));

const lines = (entries) => entries.map((e) => `${JSON.stringify(e)}\n`).join('');
export const writeOutbox = (data, entries) => writeFileAtomic(file(data), lines(entries));

const spills = (data) => {
  try {
    return readdirSync(data).filter((f) => SPILL.test(f)).map((f) => join(data, f));
  } catch {
    return [];
  }
};

const replaces = (a, b) => a.sessionId === b.sessionId && a.kind === b.kind && (a.kind !== 'event' || a.event.id === b.event.id);
const admit = (entries, entry) => [...entries.filter((e) => !replaces(e, entry)), entry];

function prepared(entry) {
  const next = { ...entry, seq: randomUUID() };
  if (entry.kind === 'event') next.event = cleanEvent(entry.event);
  if (entry.kind === 'step') next.step = clean(entry.step, LIMITS.stepLabel);
  return next;
}

function capped(data, entries) {
  const over = entries.length - MAX_ENTRIES;
  if (over <= 0) return entries;
  const dropped = join(data, 'dropped.json');
  writeJsonAtomic(dropped, { count: (Number(readJson(dropped, {}).count) || 0) + over });
  const rank = (e) => (e.kind === 'event' ? 0 : LIFECYCLE.has(e.kind) ? 2 : 1);
  const gone = new Set([...entries].sort((a, b) => rank(a) - rank(b)).slice(0, over));
  return entries.filter((e) => !gone.has(e));
}

// Caller holds withLock(data). Merges spills left by enqueues that timed out on the lock.
export function rewrite(data, fn) {
  const spilled = spills(data);
  let entries = readOutbox(data);
  for (const path of spilled) for (const e of parse(path)) entries = admit(entries, e);
  writeOutbox(data, capped(data, fn(entries)));
  for (const path of spilled) remove(path);
}

export const append = (data, entry) => rewrite(data, (entries) => admit(entries, prepared(entry)));

export async function enqueue(data, entry) {
  try {
    const next = prepared(entry);
    try {
      await withLock(data, async () => rewrite(data, (entries) => admit(entries, next)));
    } catch (e) {
      if (!(e instanceof LockTimeout) || spills(data).length >= MAX_SPILLS) return;
      writeFileAtomic(join(data, `outbox.${process.pid}.${randomBytes(6).toString('hex')}.jsonl`), lines([next]));
    }
  } catch {
    // tracking goes stale; a hook must never fail the session
  }
}

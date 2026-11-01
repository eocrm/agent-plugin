import { appendFileSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { withLock, readJson, writeJsonAtomic, writeFileAtomic, remove, LockTimeout } from './state.mjs';
import { cleanEvent } from './api.mjs';
import { clean, LIMITS } from './scrub.mjs';

export const MAX_ENTRIES = 2000;
export const MAX_SPILLS = 50;
const SPILL_LOCK_MS = 500;

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

const droppedLog = (data) => join(data, 'dropped.log');

// Spill drops append one byte each (O_APPEND, no lock); rewrite folds them into dropped.json.
function foldDropped(data) {
  const taken = `${droppedLog(data)}.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    renameSync(droppedLog(data), taken);
  } catch {
    return 0;
  }
  let size;
  try {
    size = statSync(taken).size;
  } catch {
    size = 0;
  }
  remove(taken);
  return size;
}

function capped(data, entries, alsoDropped = 0) {
  const over = Math.max(0, entries.length - MAX_ENTRIES);
  if (over + alsoDropped > 0) {
    const dropped = join(data, 'dropped.json');
    writeJsonAtomic(dropped, { count: (Number(readJson(dropped, {}).count) || 0) + over + alsoDropped });
  }
  if (over <= 0) return entries;
  const rank = (e) => (e.kind === 'event' ? 0 : LIFECYCLE.has(e.kind) ? 2 : 1);
  const gone = new Set([...entries].sort((a, b) => rank(a) - rank(b)).slice(0, over));
  return entries.filter((e) => !gone.has(e));
}

// Caller holds withLock(data). Merges spills left by enqueues that timed out on the lock.
export function rewrite(data, fn) {
  const spilled = spills(data);
  let entries = readOutbox(data);
  for (const path of spilled) for (const e of parse(path)) entries = admit(entries, e);
  writeOutbox(data, capped(data, fn(entries), foldDropped(data)));
  for (const path of spilled) remove(path);
}

export const append = (data, ...added) => rewrite(data, (entries) => added.reduce((all, e) => admit(all, prepared(e)), entries));

// The spill lock makes count-then-write atomic across processes; a finish is never dropped.
async function spill(data, entry) {
  try {
    await withLock(join(data, 'spill'), async () => {
      if (spills(data).length >= MAX_SPILLS) throw new Error('eocrm: spill cap');
      writeFileAtomic(join(data, `outbox.${process.pid}.${randomBytes(6).toString('hex')}.jsonl`), lines([entry]));
    }, { giveUpMs: SPILL_LOCK_MS });
  } catch {
    if (entry.kind === 'finish') writeFileAtomic(join(data, `outbox.${process.pid}.${randomBytes(6).toString('hex')}.jsonl`), lines([entry]));
    else appendFileSync(droppedLog(data), '.');
  }
}

export async function enqueue(data, entry, lock) {
  try {
    const next = prepared(entry);
    try {
      await withLock(data, async () => rewrite(data, (entries) => admit(entries, next)), lock);
    } catch (e) {
      if (!(e instanceof LockTimeout)) return;
      await spill(data, next);
    }
  } catch {
    // tracking goes stale; a hook must never fail the session
  }
}

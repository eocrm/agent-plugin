import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withLock, readJson, writeJsonAtomic, writeFileAtomic } from './state.mjs';
import { cleanEvent } from './api.mjs';
import { clean, LIMITS } from './scrub.mjs';

export const MAX_ENTRIES = 2000;

const file = (data) => join(data, 'outbox.jsonl');

export function readOutbox(data) {
  let text;
  try {
    text = readFileSync(file(data), 'utf8');
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

export const writeOutbox = (data, entries) => writeFileAtomic(file(data), entries.map((e) => `${JSON.stringify(e)}\n`).join(''));

const replaces = (a, b) => a.sessionId === b.sessionId && a.kind === b.kind && (a.kind !== 'event' || a.event.id === b.event.id);

function prepared(entry) {
  if (entry.kind === 'event') return { ...entry, event: cleanEvent(entry.event) };
  if (entry.kind === 'step') return { ...entry, step: clean(entry.step, LIMITS.stepLabel) };
  return entry;
}

export function append(data, entry) {
  const next = { ...prepared(entry), seq: randomUUID() };
  const kept = readOutbox(data).filter((e) => !replaces(e, next));
  kept.push(next);
  const drop = kept.length - MAX_ENTRIES;
  if (drop > 0) {
    const dropped = join(data, 'dropped.json');
    writeJsonAtomic(dropped, { count: (Number(readJson(dropped, {}).count) || 0) + drop });
  }
  writeOutbox(data, kept.slice(Math.max(0, drop)));
}

export async function enqueue(data, entry) {
  try {
    await withLock(data, async () => append(data, entry));
  } catch {
    // tracking goes stale; a hook must never fail the session
  }
}

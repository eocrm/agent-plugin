import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventId } from '../../lib/ids.mjs';
import { enqueue, readOutbox } from '../../lib/outbox.mjs';
import { readJson } from '../../lib/state.mjs';

const tmp = () => realpathSync.native(mkdtempSync(join(tmpdir(), 'eocrm-outbox-')));
const ev = (n, extra = {}) => ({ kind: 'event', sessionId: 's1', event: { id: `commit:${n}`, type: 'commit', occurred_at: '2026-11-01T00:00:00Z', sha: 'abc1234', ...extra } });

test('eventId is deterministic and at most 64 characters', () => {
  assert.equal(eventId('commit', 'abc'), eventId('commit', 'abc'));
  assert.notEqual(eventId('commit', 'abc'), eventId('commit', 'abd'));
  assert.match(eventId('commit', 'abc'), /^commit:[A-Za-z0-9_-]{22}$/);
  assert.ok(eventId('x'.repeat(100), 'k').length <= 64);
});

test('2,001 enqueues keep 2,000 and drop the first', async () => {
  const data = tmp();
  for (let i = 0; i < 2001; i++) await enqueue(data, ev(i));
  const ids = readOutbox(data).map((e) => e.event.id);
  assert.equal(ids.length, 2000);
  assert.equal(ids[0], 'commit:1');
  assert.equal(ids.at(-1), 'commit:2000');
  assert.equal(readJson(join(data, 'dropped.json')).count, 1);
});

test('two concurrent enqueue processes of 100 each leave 200 lines', async () => {
  const data = tmp();
  const outbox = new URL('../../lib/outbox.mjs', import.meta.url).href;
  const loop = (tag) => new Promise((resolve, reject) => {
    const script = `const { enqueue } = await import(${JSON.stringify(outbox)});
      for (let i = 0; i < 100; i++) await enqueue(process.argv[1], { kind: 'event', sessionId: 's1', event: { id: '${tag}:' + i, type: 'step' } });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, data], { stdio: 'inherit' });
    child.on('error', reject).on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
  await Promise.all([loop('a'), loop('b')]);
  const lines = readFileSync(join(data, 'outbox.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 200);
  assert.equal(new Set(lines.map((l) => JSON.parse(l).event.id)).size, 200);
});

test('an event id already pending is not queued twice', async () => {
  const data = tmp();
  await enqueue(data, ev(1));
  await enqueue(data, ev(1));
  await enqueue(data, { ...ev(1), sessionId: 's2' });
  assert.deepEqual(readOutbox(data).map((e) => `${e.sessionId}/${e.event.id}`), ['s1/commit:1', 's2/commit:1']);
});

test('only the newest step and heartbeat per session stay pending', async () => {
  const data = tmp();
  await enqueue(data, { kind: 'step', sessionId: 's1', step: 'one' });
  await enqueue(data, { kind: 'heartbeat', sessionId: 's1' });
  await enqueue(data, { kind: 'step', sessionId: 's2', step: 'other' });
  await enqueue(data, { kind: 'step', sessionId: 's1', step: 'two' });
  await enqueue(data, { kind: 'heartbeat', sessionId: 's1' });
  assert.deepEqual(readOutbox(data).map((e) => `${e.sessionId}/${e.kind}/${e.step ?? ''}`), ['s2/step/other', 's1/step/two', 's1/heartbeat/']);
});

test('text is scrubbed before it is queued', async () => {
  const data = tmp();
  const secret = `ghp_${'A1b2C3d4'.repeat(5)}`;
  await enqueue(data, ev(1, { subject: `push ${secret}` }));
  await enqueue(data, { kind: 'step', sessionId: 's1', step: `TOKEN=${secret}` });
  assert.doesNotMatch(readFileSync(join(data, 'outbox.jsonl'), 'utf8'), /ghp_/);
});

test('a torn or CRLF line is skipped, not fatal', async () => {
  const data = tmp();
  writeFileSync(join(data, 'outbox.jsonl'), `${JSON.stringify(ev(1))}\r\n{"kind":"ev`);
  await enqueue(data, ev(2));
  assert.deepEqual(readOutbox(data).map((e) => e.event.id), ['commit:1', 'commit:2']);
});

test('enqueue never throws on an unusable data dir or a held lock', async () => {
  const data = tmp();
  const file = join(data, 'not-a-dir');
  writeFileSync(file, '');
  await enqueue(file, ev(1));
  mkdirSync(join(data, '.lock'));
  await enqueue(data, ev(1));
  assert.deepEqual(readOutbox(data), []);
});

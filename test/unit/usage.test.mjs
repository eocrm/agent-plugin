import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readUsage, readSession, sizesOf } from '../../lib/usage.mjs';

const line = (id, model, u = {}, extra = {}) => JSON.stringify({ type: 'assistant', isSidechain: false, message: { id, model, usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, ...u } }, ...extra }) + '\n';
const file = (text) => {
  const p = join(mkdtempSync(join(tmpdir(), 'eocrm-usage-')), 't.jsonl');
  writeFileSync(p, text);
  return p;
};

test('it sums usage per model', () => {
  const p = file(line('m1', 'a') + line('m2', 'a') + line('m3', 'b', {}, { isSidechain: true }));
  const r = readUsage(p, 0);
  assert.deepEqual(r.models, {
    a: { input_tokens: 2, output_tokens: 4, cache_read_tokens: 6, cache_write_tokens: 8 },
    b: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4 },
  });
});

test('it counts a message split over several lines once', () => {
  const r = readUsage(file(line('m1', 'a').repeat(3)), 0);
  assert.equal(r.models.a.output_tokens, 2);
});

test('it ignores ids already seen in an earlier call', () => {
  assert.deepEqual(readUsage(file(line('m1', 'a')), 0, undefined, ['m1']).models, {});
});

test('it stops at a partial last line and resumes from it', () => {
  const whole = line('m2', 'a');
  const p = file(line('m1', 'a') + whole.slice(0, 20));
  const first = readUsage(p, 0);
  assert.equal(first.offset, Buffer.byteLength(line('m1', 'a')));
  assert.equal(first.models.a.input_tokens, 1);
  appendFileSync(p, whole.slice(20));
  const second = readUsage(p, first.offset);
  assert.equal(second.models.a.input_tokens, 1);
  assert.equal(second.offset, Buffer.byteLength(line('m1', 'a') + whole));
});

test('it skips synthetic and non-assistant lines', () => {
  const p = file(line('m1', '<synthetic>') + JSON.stringify({ type: 'user', message: { model: 'a', usage: { input_tokens: 9 } } }) + '\nnot json "usage"\n');
  assert.deepEqual(readUsage(p, 0).models, {});
});

test('it caps one read at maxBytes', () => {
  const l = line('m1', 'a');
  const p = file(l + line('m2', 'a'));
  const r = readUsage(p, 0, l.length + 5);
  assert.equal(r.offset, l.length);
  assert.equal(r.models.a.input_tokens, 1);
});

test('a missing file keeps the offset', () => {
  assert.deepEqual(readUsage('/nonexistent/x.jsonl', 7), { from: 7, offset: 7, models: {}, ids: [] });
});

test('it restarts a file that shrank below its offset', () => {
  const p = file(line('m1', 'a'));
  const r = readUsage(p, 100000);
  assert.equal(r.models.a.input_tokens, 1);
  assert.equal(r.offset, Buffer.byteLength(line('m1', 'a')));
});

test('it never consumes a final line without a newline, even at the cap', () => {
  const l = line('m1', 'a');
  const full = l.trimEnd();
  const p = file(full);
  const r = readUsage(p, 0, full.length);
  assert.deepEqual([r.offset, r.models], [0, {}]);
  const huge = file('x'.repeat(50) + '\n' + 'y'.repeat(50));
  assert.equal(readUsage(huge, 0, 40).offset, 40);
});

function session() {
  const dir = mkdtempSync(join(tmpdir(), 'eocrm-usage-s-'));
  const main = join(dir, 'sess.jsonl');
  const sub = join(dir, 'sess', 'subagents', 'agent-1.jsonl');
  mkdirSync(dirname(sub), { recursive: true });
  return { main, sub };
}

test('it counts subagent transcripts with per-file offsets', () => {
  const { main, sub } = session();
  writeFileSync(main, line('m1', 'a'));
  writeFileSync(sub, line('s1', 'b'));
  const first = readSession(main);
  assert.deepEqual(first.reads.map((r) => [r.file === main, Object.keys(r.models)]), [[true, ['a']], [false, ['b']]]);
  appendFileSync(sub, line('s2', 'b'));
  const second = readSession(main, first.offsets, first.ids);
  assert.deepEqual(second.reads.map((r) => Object.values(r.models).map((m) => m.input_tokens)), [[], [1]]);
});

test('it caps total bytes across files', () => {
  const { main, sub } = session();
  const l = line('m1', 'a');
  writeFileSync(main, l);
  writeFileSync(sub, line('s1', 'b'));
  const r = readSession(main, {}, [], l.length);
  assert.deepEqual(Object.keys(r.reads.map((x) => x.models).flatMap(Object.keys)), ['0']);
  assert.equal(r.offsets[sub], undefined);
});

test('sizesOf lists main and subagent sizes', () => {
  const { main, sub } = session();
  writeFileSync(main, 'abc\n');
  writeFileSync(sub, 'de\n');
  assert.deepEqual(sizesOf(main), { [main]: 4, [sub]: 3 });
});

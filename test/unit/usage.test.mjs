import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUsage } from '../../lib/usage.mjs';

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
  assert.deepEqual(readUsage('/nonexistent/x.jsonl', 7), { offset: 7, models: {}, ids: [] });
});

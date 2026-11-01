import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scrub, clean, LIMITS } from '../../lib/scrub.mjs';

const vectors = JSON.parse(readFileSync(new URL('../fixtures/scrubber-vectors.json', import.meta.url), 'utf8'));

test('vectors', () => {
  assert.ok(vectors.length > 100);
  for (const { input, expected } of vectors) assert.equal(scrub(input), expected, JSON.stringify(input));
});

test('clean truncates to the limit with a suffix', () => {
  const out = clean('x'.repeat(300), 200);
  assert.equal(out.length, 200);
  assert.ok(out.endsWith('… [truncated]'));
});

test('clean scrubs', () => {
  assert.equal(clean('API_KEY=abc', 500), 'API_KEY=[redacted]');
});

test('LIMITS', () => {
  assert.equal(LIMITS.testCommand, 500);
  assert.equal(LIMITS.rulingWhy, 1000);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scrub, clean, LIMITS } from '../../lib/scrub.mjs';

const vectors = JSON.parse(readFileSync(new URL('../fixtures/scrubber-vectors.json', import.meta.url), 'utf8'));

test('vectors', () => {
  assert.ok(vectors.length > 100);
  for (const { input, expected } of vectors) {
    assert.equal(scrub(input), input.length > 16384 ? '[redacted: unscannable]' : expected, JSON.stringify(input));
  }
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

const ms = (fn) => {
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const t = process.hrtime.bigint();
    fn();
    runs.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  return runs.sort((a, b) => a - b)[2];
};
const fill = (unit, n) => unit.repeat(Math.floor(n / unit.length) + 1).slice(0, n);

test('clean redacts a PEM cut before its END marker', () => {
  const head = '-----BEGIN RSA PRIVATE KEY-----\n';
  const tail = '\n-----END RSA PRIVATE KEY-----';
  const body = 'MIIJQk'.repeat(600).slice(0, 3272 - head.length - tail.length).replace(/(.{64})/g, '$1\n');
  const pem = (head + body).slice(0, 3272 - tail.length) + tail;
  assert.equal(pem.length, 3272);
  const out = clean(pem, 500);
  assert.doesNotMatch(out, /MIIJ|Qk/);
  assert.match(out, /\[redacted\]/);
});

test('clean never leaves a lone surrogate at the cut', () => {
  const limit = 50;
  const text = 'x'.repeat(limit - '… [truncated]'.length - 1) + '😀'.repeat(20);
  const out = clean(text, limit);
  assert.ok(out.isWellFormed(), JSON.stringify(out));
  assert.ok(out.endsWith('… [truncated]'));
  const inner = clean('API_KEY=' + 'a'.repeat(200 - 9) + '😀 tail', 50);
  assert.ok(inner.isWellFormed());
});

test('clean backs off a surrogate cut by the scan window', () => {
  const out = clean('TOKEN=' + 'a'.repeat(392) + ' 😀', 100);
  assert.equal(out, 'TOKEN=[redacted] ');
});

test('scrub fails closed above 16384 chars', () => {
  assert.equal(scrub('a'.repeat(16384)), 'a'.repeat(16384));
  assert.equal(scrub(`TOKEN=x ${'a'.repeat(16384)}`), '[redacted: unscannable]');
});

for (const unit of ['a-', '-', 'eyJ', 'mysql ', 'sk-', ' -u a', '_PASSx', 'zip ', 'redis-cli ', 'Cookie:', '-pass ', 'curl ', 'curl -b ']) {
  test(`scrubs a long adversarial field in linear time: ${JSON.stringify(unit)}`, () => {
    const text = fill(unit, 16000);
    assert.ok(ms(() => scrub(text)) < 50);
  });
}

const ordinary = {
  'curl a://b': 'curl ' + 'a://b '.repeat(660),
  'curl urls': 'curl ' + 'https://example.com/p '.repeat(180),
  'curl quoted': 'curl ' + '"a" '.repeat(990),
  'curl mixed': 'curl ' + "'a' https://e/ x ".repeat(230),
  'github urls': 'Fetched with curl:\n' + Array.from({ length: 78 }, (_, i) => `- https://github.com/eocrm/eocrm/blob/main/f${i + 1}.php`).join('\n'),
  downloads: 'curl -fsSL ' + Array.from({ length: 85 }, (_, i) => `-O https://cdn.example.org/build/pkg${i + 1}.tar.gz`).join(' '),
};
for (const [name, text] of Object.entries(ordinary)) {
  test(`keeps long ordinary command lines intact and fast: ${name}`, () => {
    assert.equal(scrub(text), text);
    assert.ok(ms(() => scrub(text)) < 50);
  });
}

for (const unit of ['curl -b hunter2 ', 'mysql -phunter2 ', "curl -b 'hunter2' ", 'x --token hunter2 ', 'a&b; curl -b hunter2|']) {
  test(`redacts long command lines in linear time: ${JSON.stringify(unit)}`, () => {
    const text = fill(unit, 4000);
    assert.doesNotMatch(scrub(text), /hunter2/);
    assert.ok(ms(() => scrub(text)) < 50);
  });
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scrub, clean, LIMITS } from '../../lib/scrub.mjs';
import { cases, accepted, SEC } from '../support/reviewer-gen.mjs';

const vectors = JSON.parse(readFileSync(new URL('../fixtures/scrubber-vectors.json', import.meta.url), 'utf8'));

test('vectors', () => {
  assert.ok(vectors.length > 100);
  const fails = [];
  for (const { input, expected, plugin } of vectors) {
    const want = input.length > 16384 ? '[redacted: unscannable]' : plugin ?? expected;
    if (scrub(input) !== want) fails.push(input);
  }
  assert.deepEqual(fails, []);
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

// Wall-clock bounds are catastrophe ceilings only; CI runners run several times slower than dev.
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

// EventPayload::clean gives "[redacted]\n": the plugin also drops the whitespace before the cut and marks it.
test('clean matches EventPayload on a PEM or token the raw cut drops', () => {
  const body = 'MIIJKAIBAAKCAgEA'.repeat(198).slice(0, 3161).replace(/(.{64})(?!$)/g, '$1\n');
  const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
  assert.equal(pem.length, 3272);
  assert.equal(clean(pem, 500), '[redacted]… [truncated]');
  const short = `-----BEGIN RSA PRIVATE KEY-----\n${'A'.repeat(1915)}\n-----END RSA PRIVATE KEY-----`;
  assert.equal(clean(`${short}\nghp_${'F'.repeat(36)}`, 500), '[redacted]… [truncated]');
});

test('clean drops the token cut by the scan window', () => {
  const head = '-----BEGIN RSA PRIVATE KEY-----\n';
  const tail = '\n-----END RSA PRIVATE KEY-----';
  const pem = head + 'MIIJQk'.repeat(400).slice(0, 1989 - head.length - tail.length) + tail;
  const out = clean(`${pem} ghp_${'A1b2C3d4e'.repeat(4)}`, 500);
  assert.doesNotMatch(out, /ghp_|MIIJ/);
  assert.ok(out.endsWith('… [truncated]'));
  assert.equal(clean(`ok ${'x'.repeat(30)}`, 5), 'ok');
  assert.doesNotMatch(clean(`ghp_${'A'.repeat(100)}`, 5), /ghp_/);
});

test('clean below the suffix length stays within the limit', () => {
  for (const limit of [5, 12]) {
    for (const text of ['x'.repeat(100), '😀'.repeat(50), `ab${'😀'.repeat(8)}`, `abc${'😀'.repeat(10)}`]) {
      const out = clean(text, limit);
      assert.ok(out.length <= limit, `${limit}: ${out}`);
      assert.ok(out.isWellFormed(), `${limit}: ${JSON.stringify(out)}`);
    }
  }
  assert.equal(clean('abcdefghijklmnop', 12), 'abcdefghijkl');
});

test('scrub fails closed above 16384 chars', () => {
  assert.equal(scrub('a'.repeat(16384)), 'a'.repeat(16384));
  assert.equal(scrub(`TOKEN=x ${'a'.repeat(16384)}`), '[redacted: unscannable]');
});

const units = JSON.parse(readFileSync(new URL('../fixtures/scrubber-linear-units.json', import.meta.url), 'utf8'));
for (const unit of units) {
  test(`scrubs a long adversarial field in linear time: ${JSON.stringify(unit)}`, () => {
    const best = [Infinity, Infinity];
    for (let run = 0; run < 5; run++) {
      [fill(unit, 4000), fill(unit, 16000)].forEach((text, i) => {
        const t = process.hrtime.bigint();
        scrub(text);
        best[i] = Math.min(best[i], Number(process.hrtime.bigint() - t) / 1e6);
      });
    }
    // 4× the input: linear ≈ 4× the time, quadratic ≈ 16×.
    assert.ok(best[1] < Math.max(10 * best[0], 20), `${best[1]}ms vs ${best[0]}ms`);
  });
}

for (const unit of ['token', 'a_TOKEN_b', 'TOKENX']) {
  test(`does not blank a field that repeats a key word without a value: ${unit}`, () => {
    const text = `x ${unit.repeat(1500)}`;
    assert.equal(scrub(text), text);
    assert.ok(ms(() => scrub(text)) < 200);
  });
}

test('scans a long backslash run once', () => {
  const text = '\\'.repeat(16000);
  assert.ok(ms(() => scrub(text)) < 250);
});

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
    assert.ok(ms(() => scrub(text)) < 250);
  });
}

for (const unit of ['curl -b hunter2 ', 'mysql -phunter2 ', "curl -b 'hunter2' ", 'x --token hunter2 ', 'a&b; curl -b hunter2|']) {
  test(`redacts long command lines in linear time: ${JSON.stringify(unit)}`, () => {
    const text = fill(unit, 4000);
    assert.doesNotMatch(scrub(text), /hunter2/);
    assert.ok(ms(() => scrub(text)) < 250);
  });
}

test('a planted secret value never survives scrub (seeded grammar)', () => {
  let seed = 20261101;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const SECRET = 'Zq9S3cr3tX';
  const FLAGS = [
    ['git', '--cookie', 'any'], ['ssh', '--oauth2-bearer', 'any'], ['x', '--proxy-user', 'any'], ['git', '-u', 'userinfo'],
    ['x', '--user', 'userinfo'], ['openssl', '-pass', 'openssl'], ['openssl', '-passin', 'openssl'], ['curl', '-b', 'any'],
    ['curl', '-u', 'not-url'], ['curl', '--user', 'not-url'], ['mysql', '--pass', 'any'], ['mysql', '-p', 'attached'],
    ['sshpass', '-p', 'any'], ['docker login', '-p', 'any'], ['redis-cli', '-a', 'any'], ['redis-cli', '--pass', 'any'],
    ['zip', '-P', 'any'], ['7z', '-p', 'attached'], ['x', '--token', 'any'], ['x', '--password', 'any'],
    ['x', '--api-key', 'any'], ['x', '--db-password', 'any'],
  ];
  const value = (mode) => {
    const core = pick([SECRET, `${SECRET}\u00a0tail`, `a${SECRET}`]);
    const raw = mode === 'userinfo' ? `u:${core}` : mode === 'openssl' ? `pass:${core}` : core;
    const dash = mode === 'any' || mode === 'attached' ? [`-${raw}`] : [];
    return pick([raw, raw, `"${raw}"`, `'${raw}'`, `$"${raw}"`, ...dash]);
  };
  const uspace = () => pick(['\u00a0', '\u3000', '\u2003', '\u00a0\u00a0']);
  const packed = () => {
    const [, flag, mode] = pick(FLAGS.filter(([c, , m]) => m !== 'attached' && ['git', 'ssh', 'x', 'openssl'].includes(c)));
    const filler = Array.from({ length: Math.floor(rand() * 3) }, () => pick(['-v', 'x', '--verbose', 'db', '-u']));
    const parts = [...filler, flag, value(mode).replace(/^["']|["']$/g, ''), ...(rand() < 0.3 ? ['tail'] : [])];
    const sep = rand() < 0.5 ? uspace : () => pick([' ', uspace()]);
    const token = parts.map((p, i) => (i ? sep() : '') + p).join('');
    return pick([token, `"${token}"`, `'${token}'`, `"${token.replace(SECRET, `\\"${SECRET}\\"`)}"`]);
  };
  const line = () => {
    if (rand() < 0.3) return `${pick(['x', 'sh -c', 'bash -lc', 'curl'])} ${packed()}${pick(['', ' db', ' -v'])}`;
    if (rand() < 0.2) {
      const key = pick(['TOKEN', 'API_KEY', 'DB_PASSWORD', 'GH_TOKEN', 'export SECRET']);
      return `${key}${pick(['=', ' = ', ': ', '\u00a0=\u00a0'])}${pick([SECRET, `"${SECRET}"`, `'${SECRET}'`, `"a\\"${SECRET}"`, `"${SECRET}`])}`;
    }
    const [cmd, flag, mode] = pick(FLAGS);
    const forms = [];
    if (mode !== 'attached') forms.push(`${flag}${pick([' ', '\t', '  '])}${value(mode)}`, `${flag}${pick(['\u00a0', '\u3000', '\u2003'])}${value(mode)}`);
    if (mode !== 'attached') forms.push(`$"${flag}" ${value(mode)}`);
    if (flag.startsWith('--')) forms.push(`${flag}=${value(mode)}`);
    if (flag.length === 2) forms.push(`${flag}${value(mode)}`);
    const before = pick(['', '-v ', '--verbose ', 'https://h/p ', '--password ', '-u root ', '--token-ttl 5 ', '-b x ']);
    const after = pick(['', ' db', ' -v', ' https://x', ' && echo ok', '; ls', '\nnext']);
    return `${cmd} ${before}${pick(forms)}${after}`;
  };
  const leaks = [];
  for (let i = 0; i < 20000; i++) {
    const text = line();
    if (scrub(text).includes(SECRET)) leaks.push(text);
  }
  assert.deepEqual(leaks.slice(0, 5), [], `${leaks.length} leaks`);
});

test("the reviewer's attack grammar leaves no secret outside the accepted rows (seeded sample)", () => {
  let seed = 20261101;
  const pick = (list) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return list[seed % list.length];
  };
  const leaks = [];
  let n = 0;
  for (const t of cases(pick)) {
    n++;
    if (accepted(t)) continue;
    const outs = [scrub(t), ...[40, 80, 200].map((lim) => clean(t, lim))];
    if (outs.some((o) => [...Array(SEC.length - 7).keys()].some((i) => o.includes(SEC.slice(i, i + 8))))) leaks.push(t);
  }
  assert.ok(n > 20000, String(n));
  assert.deepEqual(leaks.slice(0, 5), [], `${leaks.length} of ${n}`);
});

test('nested commands are scanned a few levels deep, then fail closed', () => {
  const wrap = (s) => `sh -c "${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  let ok = 'git status --short';
  let secret = 'redis-cli -a hunter2';
  for (let i = 0; i < 3; i++) [ok, secret] = [wrap(ok), wrap(secret)];
  assert.equal(scrub(ok), ok);
  assert.doesNotMatch(scrub(secret), /hunter2/);
  for (let i = 0; i < 3; i++) ok = wrap(ok);
  assert.match(scrub(ok), /\[redacted\]/);
});

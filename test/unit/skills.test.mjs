import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const NAMES = ['link-run', 'file-human-work', 'pick-type', 'record-judgement', 'login', 'status', 'use'];

function parse(name) {
  const m = /^---\nname: (.+)\ndescription: (.+)\n---\n([\s\S]*)$/.exec(readFileSync(join(root, 'skills', name, 'SKILL.md'), 'utf8'));
  assert.ok(m, `${name} frontmatter`);
  return { name: m[1], description: m[2], body: m[3] };
}

test('each skill parses and meets its caps; only plugin variables appear', () => {
  for (const n of NAMES) {
    const s = parse(n);
    assert.equal(s.name, n);
    assert.ok(s.description.length <= 200, `${n} description`);
    assert.ok(s.body.length <= 1200, `${n} body`);
    for (const [, v] of s.body.matchAll(/\$\{([^}]*)\}/g)) assert.ok(['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_SESSION_ID'].includes(v), `${n} ${v}`);
    for (const line of s.body.split('\n').filter((l) => l.includes('eocrm.mjs'))) assert.ok(line.includes('--data "${CLAUDE_PLUGIN_DATA}"'), `${n} data`);
    for (const line of s.body.split('\n').filter((l) => / (?:record|link|conventions) /.test(l))) {
      assert.ok(line.includes('--session "${CLAUDE_SESSION_ID}"'), `${n} session`);
      assert.doesNotMatch(line, /"</, `${n} model text in double quotes`);
    }
  }
});

test('skills and lib name no tenant key, person or id', () => {
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  for (const d of ['skills', 'lib']) {
    for (const f of walk(join(root, d))) assert.doesNotMatch(readFileSync(f, 'utf8'), /\bEO-|dpws|\b[0-9A-HJKMNP-TV-Z]{26}\b/, f);
  }
});

test('login, status and use exist as skills', () => {
  for (const n of ['login', 'status', 'use']) {
    assert.match(parse(n).body, new RegExp(`node "\\$\\{CLAUDE_PLUGIN_ROOT\\}/scripts/eocrm\\.mjs" ${n} --data "\\$\\{CLAUDE_PLUGIN_DATA\\}"`), n);
  }
  assert.equal(existsSync(join(root, 'commands')), false);
});

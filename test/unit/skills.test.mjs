import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const NAMES = ['link-run', 'file-human-work', 'pick-type', 'record-judgement', 'login', 'status', 'use'];

function parse(name, dir = 'skills') {
  const text = readFileSync(join(root, dir, name, 'SKILL.md'), 'utf8');
  const m = /^(---\nname: (.+)\ndescription: (.+)\n(?:(?:argument-hint|disable-model-invocation): .+\n)*---\n)([\s\S]*)$/.exec(text);
  assert.ok(m, `${dir}/${name} frontmatter`);
  return { front: m[1], name: m[2], description: m[3], body: m[4] };
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

test('link-run forbids working under another task\'s link; pick-type refreshes and creates by type key', () => {
  assert.ok(parse('link-run').body.includes('Never continue unrelated work under another task\'s link'));
  const p = parse('pick-type').body;
  for (const s of ['--refresh', 'type: "bug"', 'task_type', 'task_checklist_item']) assert.ok(p.includes(s), s);
});

test('skills and lib name no tenant key, person or id', () => {
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  for (const d of ['skills', 'codex-skills', 'lib']) {
    for (const f of walk(join(root, d))) assert.doesNotMatch(readFileSync(f, 'utf8'), /\bEO-|dpws|\b[0-9A-HJKMNP-TV-Z]{26}\b/, f);
  }
});

test('login, status and use exist as skills', () => {
  for (const n of ['login', 'status', 'use']) {
    assert.match(parse(n).body, new RegExp(`node "\\$\\{CLAUDE_PLUGIN_ROOT\\}/scripts/eocrm\\.mjs" ${n} --data "\\$\\{CLAUDE_PLUGIN_DATA\\}"`), n);
  }
  assert.equal(existsSync(join(root, 'commands')), false);
});

const ROOT_LINE = (n) => `\`<root>\` is the eocrm plugin folder: this file's path without \`/codex-skills/${n}/SKILL.md\`.\n\n`;
const forCodex = (body) => body.replaceAll(' --session "${CLAUDE_SESSION_ID}"', '').replaceAll(' --data "${CLAUDE_PLUGIN_DATA}"', '').replaceAll('${CLAUDE_PLUGIN_ROOT}', '<root>');

test('the Codex manifest points at codex-skills, one per Claude skill', () => {
  assert.equal(JSON.parse(readFileSync(join(root, '.codex-plugin/plugin.json'), 'utf8')).skills, './codex-skills/');
  assert.deepEqual(readdirSync(join(root, 'codex-skills')).sort(), readdirSync(join(root, 'skills')).sort());
});

test('each Codex skill is its Claude skill with a resolvable root and no substitutions', () => {
  for (const n of NAMES) {
    const claude = parse(n);
    const codex = parse(n, 'codex-skills');
    assert.equal(codex.front, claude.front, n);
    assert.equal(codex.body, ROOT_LINE(n) + forCodex(claude.body), n);
    assert.ok(codex.body.length <= 1300, `${n} body`);
    assert.doesNotMatch(codex.body, /\$\{|--data|--session/, n);
    for (const line of codex.body.split('\n').filter((l) => l.includes('eocrm.mjs'))) assert.ok(line.includes('node "<root>/scripts/eocrm.mjs" '), `${n}: ${line}`);
  }
});

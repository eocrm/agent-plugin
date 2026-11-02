import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = new URL('../../', import.meta.url);
const json = (p) => JSON.parse(readFileSync(new URL(p, root), 'utf8'));

test('marketplace.json lists the plugin by relative source', () => {
  const m = json('.claude-plugin/marketplace.json');
  assert.equal(m.name, 'eocrm');
  assert.ok(m.owner?.name);
  assert.ok(m.description);
  assert.equal(m.plugins[0].source, './');
  assert.equal(m.plugins[0].name, json('.claude-plugin/plugin.json').name);
  assert.ok(m.plugins[0].description);
  assert.equal('version' in m.plugins[0], false);
});

test('nightly smoke without credentials warns and exits 0', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('EOCRM_')));
  const r = spawnSync(process.execPath, [new URL('test/smoke/live.test.mjs', root).pathname], { env, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /::warning::smoke credentials not set \(OPS-2\)/);
});

test('no workflow installs or runs claude', () => {
  for (const f of ['ci.yml', 'nightly-smoke.yml']) {
    const text = readFileSync(new URL(`.github/workflows/${f}`, root), 'utf8');
    assert.doesNotMatch(text, /claude-code|npx claude|\bclaude -p\b/);
  }
});

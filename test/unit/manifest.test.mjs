import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const json = (p) => JSON.parse(readFileSync(new URL(p, root), 'utf8'));

test('plugin.json carries the required fields', () => {
  const m = json('.claude-plugin/plugin.json');
  assert.equal(m.name, 'eocrm');
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.ok(m.description);
  assert.ok(m.author?.name);
  assert.ok(m.repository);
});

test('hook commands run node from the plugin root', () => {
  if (!existsSync(new URL('hooks/hooks.json', root))) return;
  const { hooks } = json('hooks/hooks.json');
  const cmds = Object.values(hooks).flat().flatMap((g) => g.hooks);
  assert.ok(cmds.length > 0);
  for (const c of cmds) {
    assert.equal(c.command, 'node');
    assert.ok(c.args[0].startsWith('${CLAUDE_PLUGIN_ROOT}/'));
  }
});

test('no top-level bin directory', () => {
  assert.equal(existsSync(new URL('bin', root)), false);
});

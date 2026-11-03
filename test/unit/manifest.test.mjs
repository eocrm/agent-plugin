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

test('Remind entries are synchronous with a 5 s timeout', () => {
  const { hooks } = json('hooks/hooks.json');
  const remind = Object.entries(hooks).flatMap(([event, groups]) => groups.flatMap((g) => g.hooks.filter((h) => h.args[1] === 'Remind').map((h) => [event, h.async, h.timeout])));
  assert.deepEqual(remind, [['UserPromptSubmit', false, 5], ['PostToolUse', false, 5]]);
  const matcher = new RegExp(`^(?:${hooks.PostToolUse.find((g) => g.hooks[0].args[1] === 'Remind').matcher})$`);
  for (const name of ['Bash', 'mcp__plugin_eocrm-mcp_eocrm__tasks_create', 'mcp__eocrm__tasks_update', 'mcp__plugin_eocrm-mcp_eocrm__tasks_move_stage']) assert.ok(matcher.test(name), name);
  for (const name of ['Edit', 'mcp__plugin_eocrm-mcp_eocrm__tasks_get', 'mcp__github__tasks_create']) assert.ok(!matcher.test(name), name);
});

test('no top-level bin directory', () => {
  assert.equal(existsSync(new URL('bin', root)), false);
});

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

test('codex manifest names the plugin eocrm with the shared version and points at hooks/codex.json', () => {
  const m = json('.codex-plugin/plugin.json');
  assert.equal(m.name, 'eocrm');
  assert.equal(m.version, json('package.json').version);
  assert.equal(m.hooks, './hooks/codex.json');
});

test('codex hooks call dispatch with --harness codex for every event', () => {
  const { hooks } = json('hooks/codex.json');
  assert.deepEqual(Object.keys(hooks), ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'PostModelRequest', 'Stop', 'SessionEnd']);
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of groups) for (const h of g.hooks) assert.equal(h.command, `node "$PLUGIN_ROOT/hooks/dispatch.mjs" --harness codex ${event}`);
  }
  assert.equal(hooks.SessionStart[0].matcher, 'startup|resume|clear|compact|fork');
  assert.equal(hooks.SessionStart[0].hooks[0].async, false);
  assert.equal(hooks.SessionEnd[0].hooks[0].timeout, 3);
  assert.equal(hooks.Stop[0].hooks[0].async, false);
  assert.equal(hooks.PreToolUse[0].hooks[0].async, true);
});

test('claude hooks file is unchanged', () => {
  assert.deepEqual(json('hooks/hooks.json'), json('test/fixtures/claude-hooks.json'));
});

test('eocrm-mcp has a codex mcp.json pointing at the EU MCP', () => {
  assert.equal(json('mcp/.codex-plugin/plugin.json').name, 'eocrm-mcp');
  assert.deepEqual(json('mcp/mcp.json'), { mcpServers: { eocrm: { type: 'streamable-http', url: 'https://mcp.eu.eocrm.io/' } } });
});

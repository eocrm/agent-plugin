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
  for (const name of ['Bash', 'mcp__plugin_eocrm-mcp_eocrm__tasks_create', 'mcp__plugin_eocrm-mcp_eocrm__tasks_move_stage']) assert.ok(matcher.test(name), name);
  for (const name of ['Edit', 'mcp__plugin_eocrm-mcp_eocrm__tasks_get', 'mcp__github__tasks_create']) assert.ok(!matcher.test(name), name);
});

test('codex Remind entries match Claude\'s events, matcher, sync and timeout', () => {
  const rows = (file, name) => Object.entries(json(file).hooks).flatMap(([event, groups]) => groups.flatMap((g) => g.hooks.filter(name).map((h) => [event, g.matcher ?? null, h.async, h.timeout])));
  const codex = rows('hooks/codex.json', (h) => h.command.endsWith(' Remind'));
  assert.ok(codex.length > 0);
  assert.deepEqual(codex, rows('hooks/hooks.json', (h) => h.args[1] === 'Remind'));
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
    for (const g of groups) for (const h of g.hooks) assert.match(h.command, new RegExp(`^node "\\$PLUGIN_ROOT/hooks/dispatch\\.mjs" --harness codex (${event}|Remind)$`));
  }
  assert.equal(hooks.SessionStart[0].matcher, 'startup|resume|clear|compact|fork');
  assert.equal(hooks.SessionStart[0].hooks[0].async, false);
  assert.equal(hooks.SessionEnd[0].hooks[0].timeout, 3);
  assert.equal(hooks.Stop[0].hooks[0].async, false);
  assert.equal(hooks.PostModelRequest[0].hooks[0].async, false);
  assert.equal(hooks.PostModelRequest[0].hooks[0].timeout, 5);
  assert.equal(hooks.PreToolUse[0].hooks[0].async, true);
});

test('claude hooks file is unchanged', () => {
  assert.deepEqual(json('hooks/hooks.json'), json('test/fixtures/claude-hooks.json'));
});

test('eocrm-mcp has a codex mcp.json pointing at the EU MCP', () => {
  assert.equal(json('mcp/.codex-plugin/plugin.json').name, 'eocrm-mcp');
  assert.deepEqual(json('mcp/mcp.json'), { mcpServers: { eocrm: { type: 'streamable-http', url: 'https://mcp.eu.eocrm.io/' } } });
});

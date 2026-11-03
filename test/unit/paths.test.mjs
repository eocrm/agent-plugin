import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, statSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataDir, cliHarness, codexData } from '../../lib/paths.mjs';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'eocrm-')), 'a', 'b');

test('--data beats env and is created recursively', () => {
  const flag = tmp();
  assert.equal(dataDir({ argv: ['--data', flag], env: { CLAUDE_PLUGIN_DATA: tmp() } }), flag);
  assert.ok(existsSync(flag));
});

test('env is used without --data', () => {
  const dir = tmp();
  assert.equal(dataDir({ argv: [], env: { CLAUDE_PLUGIN_DATA: dir } }), dir);
  assert.ok(existsSync(dir));
});

test('throws when neither is given', () => {
  assert.throws(() => dataDir({ argv: [], env: {} }), /eocrm: no data dir/);
});

test('data dir is 0700 on POSIX, tightened if it already exists', { skip: process.platform === 'win32' }, () => {
  const dir = tmp();
  dataDir({ argv: ['--data', dir], env: {} });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  chmodSync(dir, 0o755);
  dataDir({ argv: ['--data', dir], env: {} });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('a data dir that cannot be chmodded is used as it is', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  assert.equal(dataDir({ argv: ['--data', '/'], env: {} }), '/');
});

test('--data=<dir> and a parsed value are honoured', () => {
  const eq = tmp();
  assert.equal(dataDir({ argv: [`--data=${eq}`], env: { CLAUDE_PLUGIN_DATA: tmp() } }), eq);
  const parsed = tmp();
  assert.equal(dataDir({ argv: [], env: {}, data: parsed }), parsed);
});

test('PLUGIN_DATA is the fallback when no --data and no CLAUDE_PLUGIN_DATA', () => {
  const dir = tmp();
  assert.equal(dataDir({ argv: [], env: { PLUGIN_DATA: dir } }), dir);
});

test('the CLI harness: flag, then plugin env, then install path; codex data under CODEX_HOME', () => {
  const home = join(tmpdir(), 'h');
  const env = { CODEX_HOME: join(home, '.codex') };
  const codexScript = join(home, '.codex/plugins/cache/eocrm/eocrm/0.1.4/scripts/eocrm.mjs');
  const claudeScript = join(home, '.claude/plugins/cache/eocrm/eocrm/0.1.4/scripts/eocrm.mjs');
  assert.equal(cliHarness({ env, script: codexScript }), 'codex');
  assert.equal(cliHarness({ env, script: claudeScript }), 'claude');
  assert.equal(cliHarness({ env: {}, script: join(homedir(), '.codex/plugins/cache/x/scripts/eocrm.mjs') }), 'codex');
  assert.equal(cliHarness({ env: { ...env, PLUGIN_DATA: '/d' }, script: claudeScript }), 'codex');
  assert.equal(cliHarness({ env: { ...env, CLAUDE_PLUGIN_DATA: '/d', PLUGIN_DATA: '/d' }, script: codexScript }), 'claude');
  assert.equal(cliHarness({ flag: 'claude', env, script: codexScript }), 'claude');
  assert.equal(cliHarness({ flag: 'codex', env, script: claudeScript }), 'codex');
  assert.equal(codexData(env), join(home, '.codex/plugins/data/eocrm-eocrm'));
  assert.equal(codexData({}), join(homedir(), '.codex/plugins/data/eocrm-eocrm'));
});

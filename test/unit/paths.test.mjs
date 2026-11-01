import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataDir } from '../../lib/paths.mjs';

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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, statSync, chmodSync } from 'node:fs';
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

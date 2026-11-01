import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('sync-openapi imports cleanly without a script argv', () => {
  const url = new URL('../../scripts/sync-openapi.mjs', import.meta.url).href;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

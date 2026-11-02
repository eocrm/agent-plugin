import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopGate } from '../../lib/gate.mjs';
import { loadRun, saveRun } from '../../lib/state.mjs';

const TAIL = '. Fix what it names or tell the member; tracking continues.';
const rej = (i, extra = {}) => ({ eventId: `commit:${i}`, type: 'commit', label: `c${i}`, status: 422, message: `bad ${i}`, ...extra });

function setup(rejected) {
  const data = realpathSync.native(mkdtempSync(join(tmpdir(), 'eocrm-gate-')));
  saveRun(data, 's', { rejected });
  const ctx = { data, env: {}, now: Date.now, clientFor: () => assert.fail('no request expected') };
  const stop = (extra = {}) => stopGate(ctx, { session_id: 's', cwd: data, ...extra });
  return { data, stop };
}

const reason = (out) => JSON.parse(out.stdout).reason;

test('no rejections: nothing', async () => {
  assert.deepEqual(await setup([]).stop(), {});
});

test('blocks with the exact reason; code wins over message', async () => {
  const { stop } = setup([rej(1), rej(2, { code: 'too_many' })]);
  const out = await stop();
  assert.deepEqual(JSON.parse(out.stdout), { decision: 'block', reason: `eocrm refused 2 tracking update(s): commit "c1" (422 bad 1); commit "c2" (422 too_many)${TAIL}` });
});

test('the seen-set stops a second block on the same rejections, whatever the order', async () => {
  const { data, stop } = setup([rej(1), rej(2)]);
  assert.ok((await stop()).stdout);
  saveRun(data, 's', { rejected: [rej(2), rej(1)] });
  assert.deepEqual(await stop(), {});
  assert.equal(loadRun(data, 's').blockedFingerprints.length, 1);
});

test('names at most 5 rejections but counts them all', async () => {
  const { stop } = setup(Array.from({ length: 7 }, (_, i) => rej(i)));
  const r = reason(await stop());
  assert.match(r, /^eocrm refused 7 tracking update\(s\): /);
  assert.equal(r.match(/ \(422 /g).length, 5);
  assert.ok(r.includes('"c6"') && !r.includes('"c1"'));
});

test('the reason is at most 1000 characters and keeps its last sentence', async () => {
  const { stop } = setup([rej(1, { label: 'x'.repeat(3000) })]);
  const r = reason(await stop());
  assert.ok(r.length <= 1000, `length ${r.length}`);
  assert.ok(r.endsWith(TAIL));
});

test('the reason is scrubbed', async () => {
  const { stop } = setup([rej(1, { label: 'cli --token "abc 123" x', message: "{'secret': 'abc 123'}" })]);
  const r = reason(await stop());
  assert.ok(!r.includes('abc 123'), r);
  assert.ok(r.includes('[redacted]'));
});

test('a block it cannot record is not repeated while stop_hook_active is set', async () => {
  const { data, stop } = setup([rej(1)]);
  mkdirSync(join(data, '.lock'));
  try {
    assert.deepEqual(await stop({ stop_hook_active: true }), {});
    assert.ok((await stop({ stop_hook_active: false })).stdout);
  } finally {
    rmSync(join(data, '.lock'), { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { main } from '../../scripts/eocrm.mjs';
import { readOutbox } from '../../lib/outbox.mjs';
import { saveRun, worktreeOf } from '../../lib/state.mjs';

function setup(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'eocrm-rec-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  const data = mkdtempSync(join(tmpdir(), 'eocrm-recdata-'));
  saveRun(data, 'sess', { worktreeKey: worktreeOf(dir).key, ...extra });
  return { dir, data };
}

async function cli(args, { dir, data }) {
  const out = [];
  const err = [];
  const code = await main({ argv: [...args, '--data', data], cwd: dir, env: {}, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const events = (data) => readOutbox(data).filter((e) => e.kind === 'event').map((e) => e.event);

test('record ruling enqueues a scrubbed ruling with a deterministic id', async () => {
  const s = setup();
  assert.equal((await cli(['record', 'ruling', '--what', 'x', '--why', 'API_KEY=abc'], s)).code, 0);
  assert.equal((await cli(['record', 'ruling', '--what', 'x', '--why', 'API_KEY=abc', '--cost-if-wrong', 'rework'], s)).code, 0);
  const [e, ...rest] = events(s.data);
  assert.equal(rest.length, 0, 'same what+why replaces');
  assert.equal(e.type, 'ruling');
  assert.equal(e.why, 'API_KEY=[redacted]');
  assert.equal(e.cost_if_wrong, 'rework');
  assert.match(e.id, /^ruling:/);
  const other = setup();
  await cli(['record', 'ruling', '--what', 'x', '--why', 'API_KEY=abc'], other);
  assert.equal(events(other.data)[0].id, e.id);
});

test('record finding validates severity and outcome; a later outcome replaces the finding', async () => {
  const s = setup();
  const bad = await cli(['record', 'finding', '--severity', 'huge', '--summary', 's'], s);
  assert.equal(bad.code, 2);
  assert.equal((await cli(['record', 'finding', '--summary', 's'], s)).code, 2);
  assert.equal((await cli(['record', 'finding', '--severity', 'minor', '--summary', 's', '--outcome', 'nope'], s)).code, 2);
  assert.equal(events(s.data).length, 0);
  await cli(['record', 'finding', '--severity', 'minor', '--summary', 's'], s);
  await cli(['record', 'finding', '--severity', 'minor', '--summary', 's', '--outcome', 'fixed'], s);
  const [e, ...rest] = events(s.data);
  assert.equal(rest.length, 0);
  assert.deepEqual([e.type, e.severity, e.outcome], ['review_finding', 'minor', 'fixed']);
});

test('record requires its arguments and a live run', async () => {
  const s = setup();
  assert.equal((await cli(['record', 'ruling', '--why', 'y'], s)).code, 2);
  assert.equal((await cli(['record', 'ruling', '--what', 'x'], s)).code, 2);
  assert.equal((await cli(['record', 'finding', '--severity', 'minor'], s)).code, 2);
  assert.equal((await cli(['record', 'other'], s)).code, 2);
  const none = setup();
  saveRun(none.data, 'sess', { ended: true });
  assert.equal((await cli(['record', 'ruling', '--what', 'x', '--why', 'y'], none)).code, 3);
});

test('conventions prints compact JSON without workflows', async () => {
  const s = setup({ conventions: { epic_type: 'epic', human_space: null, priorities: ['p1'], workflows: [{ a: 1 }] } });
  const r = await cli(['conventions'], s);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), { epic_type: 'epic', human_space: null, priorities: ['p1'] });
  assert.ok(!r.out.includes('\n') && !r.out.includes('workflows'));
});

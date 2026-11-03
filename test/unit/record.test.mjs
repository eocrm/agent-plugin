import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { main } from '../../scripts/eocrm.mjs';
import { readOutbox } from '../../lib/outbox.mjs';
import { loadRun, saveRun, worktreeOf } from '../../lib/state.mjs';

function setup(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'eocrm-rec-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  const data = mkdtempSync(join(tmpdir(), 'eocrm-recdata-'));
  saveRun(data, 'sess', { worktreeKey: worktreeOf(dir).key, ...extra });
  return { dir, data };
}

async function cli(args, { dir, data }, extra = {}) {
  const out = [];
  const err = [];
  const code = await main({ argv: [...args, '--data', data], cwd: dir, env: {}, ...extra, out: (l) => out.push(l), err: (l) => err.push(l) });
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

test('record finding validates severity and outcome; a new outcome is a new event', async () => {
  const s = setup();
  const bad = await cli(['record', 'finding', '--severity', 'huge', '--summary', 's'], s);
  assert.equal(bad.code, 2);
  assert.equal((await cli(['record', 'finding', '--summary', 's'], s)).code, 2);
  assert.equal((await cli(['record', 'finding', '--severity', 'minor', '--summary', 's', '--outcome', 'nope'], s)).code, 2);
  assert.equal(events(s.data).length, 0);
  await cli(['record', 'finding', '--severity', 'minor', '--summary', 's'], s);
  await cli(['record', 'finding', '--severity', 'minor', '--summary', 's', '--outcome', 'fixed'], s);
  await cli(['record', 'finding', '--severity', 'minor', '--summary', 's', '--outcome', 'fixed'], s);
  const [a, b, ...rest] = events(s.data);
  assert.equal(rest.length, 0, 'same outcome is idempotent');
  assert.notEqual(a.id, b.id, 'a new outcome is a new event');
  assert.deepEqual([b.type, b.severity, b.outcome], ['review_finding', 'minor', 'fixed']);
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
  const s = setup({ workspace: 'ws', conventionsAt: Date.now(), conventions: { epic_type: 'epic', human_space: null, priorities: ['p1'], workflows: [{ a: 1 }] } });
  const r = await cli(['conventions'], s);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), { workspace: 'ws', epic_type: 'epic', human_space: null, priorities: ['p1'] });
  assert.ok(!r.out.includes('\n') && !r.out.includes('workflows'));
});

test('conventions fetches once when none are cached, and exits 3 when it cannot', async (t) => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ human_space: 'h', workflows: [] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { EOCRM_ENDPOINTS: JSON.stringify({ issuer: base, api: `${base}/{workspace}/api` }) };
  const store = { get: async () => ({ access_token: 'a' }), update: async () => null };
  const s = setup({ workspace: 'ws', region: 'eu', conventions: null });
  const r = await cli(['conventions'], s, { env, store });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { workspace: 'ws', human_space: 'h' });
  assert.equal(loadRun(s.data, 'sess').conventions.human_space, 'h');
  await cli(['conventions'], s, { env, store });
  assert.equal(hits, 1);
  const down = setup({ workspace: 'ws', region: 'eu' });
  const failed = await cli(['conventions'], down, { env, store: { get: async () => null, update: async () => null } });
  assert.equal(failed.code, 3);
  assert.equal(failed.out, '');
  assert.match(failed.err, /conventions unavailable: ask the member/);
});

test('record exits 1 when the entry reaches neither the outbox nor a spill', async () => {
  const s = setup();
  mkdirSync(join(s.data, 'outbox.jsonl'));
  const r = await cli(['record', 'ruling', '--what', 'x', '--why', 'y'], s);
  assert.equal(r.code, 1);
  assert.match(r.err, /not recorded/);
  assert.equal(r.out, '');
});

test('--session targets that run; an unknown session falls back to the newest', async () => {
  const s = setup();
  saveRun(s.data, 'other', { worktreeKey: worktreeOf(s.dir).key });
  await cli(['record', 'ruling', '--what', 'a', '--why', 'b', '--session', 'sess'], s);
  await cli(['record', 'ruling', '--what', 'c', '--why', 'd', '--session', 'nope'], s);
  const by = Object.fromEntries(readOutbox(s.data).filter((e) => e.kind === 'event').map((e) => [e.event.what, e.sessionId]));
  assert.deepEqual(by, { a: 'sess', c: 'other' });
  await cli(['link', 'ABC-1', '--session', 'sess'], s, { spawnFlush: () => {} });
  assert.equal(loadRun(s.data, 'sess').start.task, 'ABC-1');
  assert.equal(loadRun(s.data, 'other').start?.task, undefined);
});

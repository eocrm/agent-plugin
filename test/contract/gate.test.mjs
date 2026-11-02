import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { handle, runClient } from '../../lib/run.mjs';
import { flush } from '../../lib/flush.mjs';
import { enqueue } from '../../lib/outbox.mjs';
import { main } from '../../scripts/eocrm.mjs';
import { startFixtureServer } from '../support/fixture-server.mjs';

const tmp = (p) => realpathSync.native(mkdtempSync(join(tmpdir(), `eocrm-${p}-`)));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });
const badPr = (n) => ({ id: `pull_request:bad${n}`, type: 'pull_request', action: 'opened', url: `not a url ${n}` });
let n = 0;

async function setup(t, responses = {}) {
  const server = await startFixtureServer({ responses });
  t.after(() => server.close());
  const data = tmp('data');
  writeFileSync(join(data, 'account.json'), JSON.stringify({ region: 'eu', workspace: 'acme', workspaces: { acme: 'standalone' } }));
  const dir = tmp('repo');
  git(dir, 'init', '-q', '-b', 'feat/AB-12-x');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  let tokens = { access_token: server.auth.access, refresh_token: server.auth.refresh, client_id: server.auth.clientId };
  const store = {
    get: async () => tokens,
    update: async (key, fn) => {
      const next = await fn(tokens);
      if (next) tokens = next;
      return next;
    },
    del: async () => {
      tokens = null;
    },
  };
  const ctx = { data, env: server.endpointsEnv, now: Date.now, store, spawnFlush: () => {} };
  const sid = `gate-${process.pid}-${++n}`;
  const input = { session_id: sid, cwd: dir };
  await handle('SessionStart', { ...input, source: 'startup' }, ctx);
  await flush({ data, deadlineMs: 5000, clientFor: runClient(ctx) });
  const push = (event) => enqueue(data, { kind: 'event', sessionId: sid, event: { occurred_at: '2026-11-01T00:00:00Z', ...event } });
  const stop = (extra = {}) => handle('Stop', { ...input, stop_hook_active: false, ...extra }, ctx);
  return { server, data, ctx, push, stop };
}

const blocked = (out) => JSON.parse(out.stdout);

test('a 503 from eocrm never blocks and prints nothing', async (t) => {
  const { push, stop } = await setup(t, { 'agentRun.events.store': { status: 503, body: { message: 'down' } } });
  await push({ id: 'commit:ok', type: 'commit', sha: 'abc1234', subject: 'fine' });
  assert.deepEqual(await stop(), {});
});

test('a refused connection never blocks', async (t) => {
  const { push, stop, ctx } = await setup(t);
  ctx.env = { EOCRM_ENDPOINTS: JSON.stringify({ issuer: 'http://127.0.0.1:9', api: 'http://127.0.0.1:9/{workspace}/api' }) };
  await push(badPr(1));
  assert.deepEqual(await stop(), {});
});

test('a 401 never blocks and signs out locally', async (t) => {
  const { server, push, stop, data, ctx } = await setup(t);
  server.auth.access = 'revoked';
  server.auth.refresh = 'revoked';
  await push(badPr(1));
  assert.deepEqual(await stop(), {});
  const lines = [];
  await main({ argv: ['status', '--data', data], env: ctx.env, cwd: data, out: (l) => lines.push(l), store: ctx.store });
  assert.equal(lines[0], 'signed out: run /eocrm:login');
});

test('a 422 blocks once naming the event; stop_hook_active on the same set does not re-block; a new one blocks again', async (t) => {
  const { push, stop } = await setup(t);
  await push({ id: 'commit:ok', type: 'commit', sha: 'abc1234', subject: 'fine' });
  await push(badPr(1));
  const first = blocked(await stop());
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /^eocrm refused 1 tracking update\(s\): pull_request "not a url 1" \(422 .+\)\. Fix what it names or tell the member; tracking continues\.$/);
  assert.deepEqual(await stop({ stop_hook_active: true }), {});
  await push(badPr(2));
  const again = blocked(await stop({ stop_hook_active: true }));
  assert.match(again.reason, /^eocrm refused 2 tracking update\(s\): .*"not a url 2"/);
});

test('a refusal eocrm records as review_finding answers 200 and does not block', async (t) => {
  const { push, stop } = await setup(t, { 'agentRun.events.store': { status: 200, body: { accepted: 1, duplicates: 0, dropped: 0 } } });
  await push({ id: 'review_finding:x', type: 'review_finding', severity: 'important', summary: 'tracking refused' });
  assert.deepEqual(await stop(), {});
});

test('the gate returns within 25 s against a server that hangs', async (t) => {
  const { push, stop, ctx } = await setup(t);
  const hang = createServer(() => {});
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  t.after(() => {
    hang.closeAllConnections();
    hang.close();
  });
  const url = `http://127.0.0.1:${hang.address().port}`;
  ctx.env = { EOCRM_ENDPOINTS: JSON.stringify({ issuer: url, api: `${url}/{workspace}/api` }) };
  for (let i = 0; i < 3; i++) await push(badPr(i));
  const started = Date.now();
  assert.deepEqual(await stop(), {});
  assert.ok(Date.now() - started < 25000, `took ${Date.now() - started} ms`);
});

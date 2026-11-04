import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { handle, runClient } from '../../lib/run.mjs';
import { flush } from '../../lib/flush.mjs';
import { append, enqueue } from '../../lib/outbox.mjs';
import { endpoints } from '../../lib/endpoints.mjs';
import { credentialStore } from '../../lib/credentials.mjs';
import { writeJsonAtomic } from '../../lib/state.mjs';
import { main } from '../../scripts/eocrm.mjs';
import { startFixtureServer } from '../support/fixture-server.mjs';

const SIGNED_OUT = { stdout: JSON.stringify({ systemMessage: 'eocrm: you\'re signed out of eocrm; run /eocrm:login.' }) };

const tmp = (p) => realpathSync.native(mkdtempSync(join(tmpdir(), `eocrm-${p}-`)));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });
const badPr = (n) => ({ id: `pull_request:bad${n}`, type: 'pull_request', action: 'opened', url: `not a url ${n}` });
const commit = (i) => ({ id: `commit:ok${i}`, type: 'commit', sha: `abc${String(i).padStart(4, '0')}`, subject: 'fine' });
const AT = '2026-11-01T00:00:00Z';
let n = 0;

async function hangingEnv(t, store) {
  const hang = createServer(() => {});
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  t.after(() => {
    hang.closeAllConnections();
    hang.close();
  });
  const url = `http://127.0.0.1:${hang.address().port}`;
  const env = { EOCRM_ENDPOINTS: JSON.stringify({ issuer: url, api: `${url}/{workspace}/api` }) };
  await store.set(endpoints({ region: 'eu', env }).key, { access_token: 'a', refresh_token: 'r', client_id: 'c' });
  return env;
}

async function setup(t, responses = {}) {
  const server = await startFixtureServer({ responses });
  t.after(() => server.close());
  const data = tmp('data');
  writeFileSync(join(data, 'account.json'), JSON.stringify({ region: 'eu', workspace: 'acme', workspaces: { acme: 'standalone' } }));
  const dir = tmp('repo');
  git(dir, 'init', '-q', '-b', 'feat/AB-12-x');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  const store = credentialStore({ data, platform: 'none' });
  const key = endpoints({ region: 'eu', env: server.endpointsEnv }).key;
  await store.set(key, { access_token: server.auth.access, refresh_token: server.auth.refresh, client_id: server.auth.clientId });
  const spawned = [];
  const ctx = { data, env: server.endpointsEnv, now: Date.now, store, spawnFlush: () => spawned.push(1) };
  const sid = `gate-${process.pid}-${++n}`;
  const input = { session_id: sid, cwd: dir };
  await handle('SessionStart', { ...input, source: 'startup' }, ctx);
  await flush({ data, deadlineMs: 5000, clientFor: runClient(ctx) });
  spawned.length = 0;
  const push = (event) => enqueue(data, { kind: 'event', sessionId: sid, event: { occurred_at: AT, ...event } });
  const stop = (extra = {}) => handle('Stop', { ...input, stop_hook_active: false, ...extra }, ctx);
  const status = async () => {
    const lines = [];
    await main({ argv: ['status', '--data', data], env: ctx.env, cwd: data, out: (l) => lines.push(l), store });
    return lines[0];
  };
  return { server, data, ctx, sid, key, push, stop, status, spawned };
}

const blocked = (out) => JSON.parse(out.stdout);
// Delays every recordEvents call after the first by `ms`.
const slowEvents = (ctx, ms, { first = false } = {}) => {
  const base = runClient(ctx);
  let calls = 0;
  return (run) => {
    const c = base(run);
    return { ...c, recordEvents: async (...a) => { if (first || calls++) await sleep(ms); return c.recordEvents(...a); } };
  };
};

test('a 503 from eocrm never blocks and prints nothing', async (t) => {
  const { push, stop } = await setup(t, { 'agentRun.events.store': { status: 503, body: { message: 'down' } } });
  await push(commit(1));
  assert.deepEqual(await stop(), {});
});

test('a refused connection never blocks', async (t) => {
  const { push, stop, ctx } = await setup(t);
  ctx.env = { EOCRM_ENDPOINTS: JSON.stringify({ issuer: 'http://127.0.0.1:9', api: 'http://127.0.0.1:9/{workspace}/api' }) };
  await push(badPr(1));
  assert.equal(JSON.parse((await stop()).stdout ?? '{}').decision, undefined);
});

test('a 401 never blocks and signs out locally', async (t) => {
  const { server, push, stop, status } = await setup(t);
  server.auth.access = 'revoked';
  server.auth.refresh = 'revoked';
  await push(badPr(1));
  assert.deepEqual(await stop(), SIGNED_OUT);
  assert.equal(await status(), 'signed out: run /eocrm:login');
});

test('a 401 keeps tokens stored by a login that landed meanwhile', async (t) => {
  let data;
  let key;
  let server;
  const { push, stop, status, ...rest } = await setup(t, {
    'oauth.token': () => {
      // A login lands while flush's refresh is in flight.
      const last = server.requests.filter((r) => !r.path.startsWith('/oauth')).at(-1);
      if (last.method === 'POST' && last.path.endsWith('/events')) writeJsonAtomic(join(data, 'credentials.json'), { [key]: { access_token: 'newer', refresh_token: 'newer', client_id: 'fixture-client' } }, { mode: 0o600 });
      return { status: 400, body: { error: 'invalid_grant', message: 'The refresh token is invalid.' } };
    },
  });
  ({ data, key, server } = rest);
  server.auth.access = 'revoked';
  await push(badPr(1));
  assert.deepEqual(await stop(), SIGNED_OUT);
  assert.equal(await status(), 'signed in (eu)');
});

test('a 422 blocks once naming the event; stop_hook_active on the same set does not re-block; a new one blocks again', async (t) => {
  const { push, stop } = await setup(t);
  await push(commit(1));
  await push(badPr(1));
  const first = blocked(await stop());
  assert.equal(first.decision, 'block');
  assert.equal(first.reason, 'eocrm refused 1 tracking update(s): pull_request "not a url 1" (422 url). Fix what it names or tell the member; tracking continues.');
  assert.deepEqual(await stop({ stop_hook_active: true }), {});
  await push(badPr(2));
  const again = blocked(await stop({ stop_hook_active: true }));
  assert.match(again.reason, /^eocrm refused 2 tracking update\(s\): .*"not a url 2" \(422 url\)/);
});

test('a refusal eocrm records as review_finding answers 200 and does not block', async (t) => {
  const { push, stop } = await setup(t, { 'agentRun.events.store': { status: 200, body: { accepted: 1, duplicates: 0, dropped: 0 } } });
  await push({ id: 'review_finding:x', type: 'review_finding', severity: 'important', summary: 'tracking refused' });
  assert.deepEqual(await stop(), {});
});

test('a heartbeat-due Stop spawns no flush, and the gate waits for a running flush', async (t) => {
  const { push, stop, ctx, data, spawned } = await setup(t);
  const later = Date.now() + 10 * 60 * 1000;
  ctx.now = () => later;
  ctx.clientFor = slowEvents(ctx, 400, { first: true });
  await push(badPr(1));
  const background = flush({ data, deadlineMs: 5000, clientFor: ctx.clientFor });
  const out = await stop();
  await background;
  assert.deepEqual(spawned, []);
  assert.match(blocked(out).reason, /"not a url 1" \(422 url\)/);
});

test('the flush deadline leaves time to block before the gate gives up', { timeout: 40000 }, async (t) => {
  const { push, stop, ctx, data, sid } = await setup(t);
  ctx.clientFor = slowEvents(ctx, 2500);
  // A slow reconcile leaves flush less than its full 20 s.
  ctx.reconcile = async () => {
    await sleep(8000);
    return { enqueued: 0 };
  };
  await push(badPr(1));
  append(data, ...Array.from({ length: 1500 }, (_, i) => ({ kind: 'event', sessionId: sid, event: { occurred_at: AT, ...commit(i) } })));
  const started = Date.now();
  const out = await stop();
  assert.ok(out.stdout, `no block after ${Date.now() - started} ms`);
});

test('the gate returns within 25 s against a server that hangs', async (t) => {
  const { push, stop, ctx } = await setup(t);
  ctx.env = await hangingEnv(t, ctx.store);
  for (let i = 0; i < 3; i++) await push(badPr(i));
  const started = Date.now();
  assert.deepEqual(await stop(), {});
  assert.ok(Date.now() - started < 25000, `took ${Date.now() - started} ms`);
});

test('the gate returns within 25 s when the keychain hangs too', { timeout: 40000 }, async (t) => {
  const { push, stop, ctx, data } = await setup(t);
  ctx.env = await hangingEnv(t, ctx.store);
  ctx.store = credentialStore({ data, platform: 'linux', run: () => new Promise(() => {}) });
  await push(badPr(1));
  const started = Date.now();
  assert.deepEqual(await stop(), {});
  assert.ok(Date.now() - started < 25000, `took ${Date.now() - started} ms`);
});

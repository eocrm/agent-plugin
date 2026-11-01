import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { endpoints } from '../../lib/endpoints.mjs';
import { createClient, NetworkError, MAX_BODY } from '../../lib/api.mjs';
import { credentialStore } from '../../lib/credentials.mjs';
import { LockTimeout } from '../../lib/state.mjs';
import { LIMITS } from '../../lib/scrub.mjs';
import { OPERATIONS } from '../../scripts/sync-openapi.mjs';
import { startFixtureServer } from '../support/fixture-server.mjs';

const snapshot = JSON.parse(readFileSync(new URL('./openapi.agent.json', import.meta.url), 'utf8'));
const GHP = `ghp_${'A1b2C3d4'.repeat(5)}`;

function memoryStore(tokens) {
  const saved = new Map(tokens ? [[null, tokens]] : []);
  return {
    sets: 0,
    keys: new Set(),
    async get(key) {
      if (key !== undefined) this.keys.add(key);
      return saved.get(null) ?? null;
    },
    async set(key, t) {
      this.keys.add(key);
      this.sets += 1;
      saved.set(null, t);
      return 'file';
    },
    async update(issuer, fn) {
      const latest = await this.get(issuer);
      const next = await fn(latest);
      if (next && next !== latest) await this.set(issuer, next);
      return next;
    },
  };
}

async function setup(t, { responses, tokens, ...opts } = {}) {
  const server = await startFixtureServer({ responses });
  t.after(() => server.close());
  const store = memoryStore(tokens ?? { access_token: server.auth.access, refresh_token: server.auth.refresh, expires_at: 0, client_id: server.auth.clientId });
  const client = createClient({ endpoints: endpoints({ region: 'eu', env: server.endpointsEnv }), workspace: 'acme', store, ...opts });
  return { server, store, client };
}

test('snapshot is the pinned slice of eocrm 0.19.5', () => {
  assert.equal(snapshot.info.version, '0.19.5');
  const ops = Object.entries(snapshot.paths).flatMap(([p, ms]) => Object.keys(ms).map((m) => `${m} ${p}`));
  assert.deepEqual(ops.sort(), OPERATIONS.map(([p, m]) => `${m} ${p}`).sort());
});

test('each method hits its documented path with the bearer', async (t) => {
  const { server, client } = await setup(t);
  const run = await client.startRun({ client_run_id: 's1', branch: 'feature/X-1', repo: 'o/r' });
  assert.equal(run.status, 201);
  assert.equal((await client.startRun({ client_run_id: 's1' })).status, 200);
  const id = run.body.id;
  assert.equal((await client.updateRun(id, { step: 'Task 1' })).body.step, 'Task 1');
  assert.deepEqual(await client.heartbeat(id), { status: 204, body: null });
  const events = [{ id: 'commit:a', type: 'commit', sha: 'abc1234', subject: 's' }, { id: 'step:b', type: 'step', phase: 'started', label: 'l' }];
  assert.deepEqual((await client.recordEvents(id, events)).body, { accepted: 2, duplicates: 0, dropped: 0 });
  assert.deepEqual((await client.recordEvents(id, events)).body, { accepted: 0, duplicates: 2, dropped: 0 });
  const list = await client.listEvents(id);
  assert.deepEqual([list.body.items.map((e) => e.id), list.body.next_cursor], [['commit:a', 'step:b'], null]);
  await client.listEvents(id, 'c/1');
  assert.equal((await client.conventions()).status, 200);
  const pairable = await client.pairable();
  assert.equal(pairable.body.items.length, 1);
  assert.deepEqual((await client.pair(pairable.body.items[0].id)).body.status, 'pending');

  const seen = server.requests.map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(seen, [
    'POST /v1/agent-runs', 'POST /v1/agent-runs', `PATCH /v1/agent-runs/${id}`, `POST /v1/agent-runs/${id}/heartbeat`,
    `POST /v1/agent-runs/${id}/events`, `POST /v1/agent-runs/${id}/events`, `GET /v1/agent-runs/${id}/events`,
    `GET /v1/agent-runs/${id}/events`, 'GET /v1/agent-work/conventions', 'GET /v1/agent-runs/pairable', 'POST /v1/agent-runs/pair',
  ]);
  assert.deepEqual(server.requests[7].query, { cursor: 'c/1' });
  for (const r of server.requests) {
    assert.equal(r.workspace, 'acme');
    assert.equal(r.headers.authorization, 'Bearer fixture-access-0');
  }
});

test('outgoing free text is scrubbed and capped', async (t) => {
  const { server, client } = await setup(t);
  const { body: run } = await client.startRun({ client_run_id: 's1', branch: `b-${GHP}`, worktree: 'w'.repeat(600), repo: `https://u:${GHP}@github.com/o/r` });
  await client.updateRun(run.id, { step: `step ${GHP} ${'x'.repeat(300)}` });
  await client.recordEvents(run.id, [
    { id: 't', type: 'test_run', command: `curl -H "Authorization: Bearer ${GHP}" ${'y'.repeat(600)}`, result_line: GHP, exit_code: 0 },
    { id: 'r', type: 'ruling', what: GHP, why: GHP, cost_if_wrong: GHP },
    { id: 'p', type: 'pull_request', action: 'opened', url: `https://u:${GHP}@github.com/o/r/pull/1`, repo: 'o/r', number: 1 },
    { id: 'f', type: 'review_finding', severity: 'minor', summary: 'z'.repeat(1200), outcome: 'open' },
    { id: 'pl', type: 'plan', source: 'todo', items: [{ key: 'k', text: `${GHP}${'q'.repeat(600)}` }] },
  ]);
  const sent = JSON.stringify(server.requests.map((r) => r.body));
  assert.ok(!sent.includes(GHP), sent);
  const [start, update, events] = server.requests.map((r) => r.body);
  assert.ok(start.worktree.length <= 500);
  assert.ok(update.step.length <= LIMITS.stepLabel);
  const [testRun, , pr, finding, plan] = events.events;
  assert.ok(testRun.command.length <= LIMITS.testCommand);
  assert.ok(finding.summary.length <= LIMITS.findingSummary);
  assert.ok(plan.items[0].text.length <= 500);
  assert.ok(pr.url.startsWith('https://'));
});

test('401 refreshes once, retries, and stores the rotated tokens', async (t) => {
  const { server, client, store } = await setup(t, { tokens: { access_token: 'stale', refresh_token: 'fixture-refresh-0', expires_at: 0, client_id: 'fixture-client' } });
  assert.equal((await client.conventions()).status, 200);
  assert.deepEqual(server.requests.map((r) => `${r.method} ${r.path}`), ['GET /v1/agent-work/conventions', 'POST /oauth/token', 'GET /v1/agent-work/conventions']);
  assert.deepEqual(server.requests[1].body, { grant_type: 'refresh_token', client_id: 'fixture-client', refresh_token: 'fixture-refresh-0' });
  assert.equal(server.requests[2].headers.authorization, 'Bearer fixture-access-1');
  const saved = await store.get();
  assert.deepEqual([...store.keys], [`${server.url} ${server.url}`]);
  assert.equal(saved.refresh_token, 'fixture-refresh-1');
  assert.equal(saved.access_token, 'fixture-access-1');
  assert.equal(saved.client_id, 'fixture-client');
  assert.ok(saved.expires_at > Date.now() / 1000);
});

test('a 401 after another process refreshed retries with its tokens', async (t) => {
  const { server, client, store } = await setup(t);
  const valid = await store.get();
  let reads = 0;
  store.get = async () => (++reads === 1 ? { ...valid, access_token: 'stale' } : valid);
  assert.equal((await client.conventions()).status, 200);
  assert.deepEqual(server.requests.map((r) => r.path), ['/v1/agent-work/conventions', '/v1/agent-work/conventions']);
  assert.equal(store.sets, 0);
});

test('a sign-out during the first 401 is not undone by the refresh', async (t) => {
  const server = await startFixtureServer();
  t.after(() => server.close());
  const data = mkdtempSync(join(tmpdir(), 'eocrm-api-'));
  const ep = endpoints({ region: 'eu', env: server.endpointsEnv });
  const stale = { access_token: 'stale', refresh_token: server.auth.refresh, expires_at: 0, client_id: server.auth.clientId };
  writeFileSync(join(data, 'credentials.json'), JSON.stringify({ [ep.key]: stale }), { mode: 0o600 });
  const store = credentialStore({ data, platform: 'none' });
  const fetch = async (url, init) => {
    const res = await globalThis.fetch(url, init);
    if (res.status === 401) await store.del(ep.key);
    return res;
  };
  const client = createClient({ endpoints: ep, workspace: 'acme', store, fetch });
  assert.equal((await client.conventions()).status, 401);
  assert.equal(await store.get(ep.key), null);
  assert.equal(server.requests.filter((r) => r.path === '/oauth/token').length, 0);
});

test('two processes refreshing at once spend the refresh token once', async (t) => {
  const server = await startFixtureServer();
  t.after(() => server.close());
  const data = mkdtempSync(join(tmpdir(), 'eocrm-api-'));
  const ep = endpoints({ region: 'eu', env: server.endpointsEnv });
  const stale = { access_token: 'stale', refresh_token: server.auth.refresh, expires_at: 0, client_id: server.auth.clientId };
  writeFileSync(join(data, 'credentials.json'), JSON.stringify({ [ep.key]: stale }), { mode: 0o600 });
  const client = () => createClient({ endpoints: ep, workspace: 'acme', store: credentialStore({ data, platform: 'none' }) });
  const results = await Promise.all([client().conventions(), client().conventions()]);
  assert.deepEqual(results.map((r) => r.status), [200, 200]);
  assert.equal(server.requests.filter((r) => r.path === '/oauth/token').length, 1);
});

test('a refresh that cannot get the lock retries with tokens another process stored', async (t) => {
  const { server, client, store } = await setup(t);
  const valid = await store.get();
  let reads = 0;
  store.get = async () => (++reads === 1 ? { ...valid, access_token: 'stale' } : valid);
  store.update = async () => { throw new LockTimeout('x'); };
  assert.equal((await client.conventions()).status, 200);
  assert.deepEqual(server.requests.map((r) => r.path), ['/v1/agent-work/conventions', '/v1/agent-work/conventions']);
});

test('a refresh that cannot get the lock and finds nothing newer is transient', async (t) => {
  const { server, client, store } = await setup(t, { tokens: { access_token: 'stale', refresh_token: 'fixture-refresh-0', expires_at: 0, client_id: 'fixture-client' } });
  store.update = async () => { throw new LockTimeout('x'); };
  assert.deepEqual(await client.conventions(), { status: 503, body: null });
  assert.equal(store.sets, 0);
  assert.deepEqual(server.requests.map((r) => r.path), ['/v1/agent-work/conventions']);
});

test('a second 401 is returned without looping', async (t) => {
  let calls = 0;
  const { server, client } = await setup(t, {
    responses: { 'agentWorkConventions.show': { status: 401, body: { message: 'Unauthenticated.' } } },
    fetch: (url, init) => (++calls > 5 ? Promise.reject(new Error('looping')) : globalThis.fetch(url, init)),
  });
  assert.equal((await client.conventions()).status, 401);
  assert.deepEqual(server.requests.map((r) => r.path), ['/v1/agent-work/conventions', '/oauth/token', '/v1/agent-work/conventions']);
});

test('a refused refresh returns the 401 and keeps the stored tokens', async (t) => {
  const tokens = { access_token: 'stale', refresh_token: 'revoked', expires_at: 0, client_id: 'fixture-client' };
  const { server, client, store } = await setup(t, { tokens });
  assert.equal((await client.heartbeat('x')).status, 401);
  assert.equal(server.requests.length, 2);
  assert.equal(store.sets, 0);
});

test('no stored tokens answers 401 without a request', async (t) => {
  const { server } = await setup(t);
  const c =createClient({ endpoints: endpoints({ region: 'eu', env: server.endpointsEnv }), workspace: 'acme', store: memoryStore() });
  assert.deepEqual(await c.pairable(), { status: 401, body: null });
  assert.equal(server.requests.length, 0);
});

test('a network error never carries the token', async (t) => {
  const { client } = await setup(t, {
    fetch: async (_url, init) => {
      throw new Error(`connect ECONNREFUSED; ${init.headers.authorization}`, { cause: new Error(init.headers.authorization) });
    },
  });
  await assert.rejects(client.conventions(), (e) => {
    assert.ok(e instanceof NetworkError);
    assert.ok(!inspect(e, { depth: 5 }).includes('fixture-access-0'), inspect(e));
    assert.match(e.message, /GET \/v1\/agent-work\/conventions/);
    return true;
  });
});

test('a refresh network error never carries the refresh token', async (t) => {
  let calls = 0;
  const { client } = await setup(t, {
    fetch: async (url, init) => {
      calls += 1;
      if (calls === 1) return new Response('{"message":"Unauthenticated."}', { status: 401 });
      throw new Error(`failed ${init.body}`);
    },
  });
  await assert.rejects(client.conventions(), (e) => e instanceof NetworkError && !inspect(e).includes('fixture-refresh-0'));
});

test('requests time out', async (t) => {
  const { client } = await setup(t, {
    timeoutMs: 20,
    fetch: (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
  });
  await assert.rejects(client.heartbeat('x'), (e) => e instanceof NetworkError && /timeout/.test(e.message));
});

test('fixture answers 422 for a body that breaks the contract', async (t) => {
  const { server, client } = await setup(t);
  const { body: run } = await client.startRun({ client_run_id: 's1' });
  assert.equal((await client.recordEvents(run.id, [])).status, 422);
  const bad = await client.recordEvents(run.id, [{ id: 'x', type: 'nope' }]);
  assert.equal(bad.status, 422);
  assert.ok(bad.body.errors['events.0.type']);
  assert.equal((await client.startRun({})).status, 422);
  assert.equal(server.requests.length, 4);
});

test('fixture answers 409 run_ended for an update on an ended run', async (t) => {
  const { client } = await setup(t);
  const { body: run } = await client.startRun({ client_run_id: 's1' });
  assert.equal((await client.updateRun(run.id, { state: 'finished' })).body.state, 'finished');
  assert.deepEqual((await client.updateRun(run.id, { step: 'late' })).body.code, 'run_ended');
  assert.equal((await client.updateRun(run.id, { state: 'running' })).status, 409);
  assert.equal((await client.heartbeat(run.id)).status, 409);
  assert.equal((await client.updateRun(run.id, { state: 'finished' })).status, 200);
});

test('fixture refuses its own off-contract responses', async (t) => {
  const { client } = await setup(t, { responses: { 'agentRun.pairable': { status: 200, body: { items: [{ id: 1 }] } } } });
  const r = await client.pairable();
  assert.equal(r.status, 500);
  assert.match(r.body.message, /violates contract/);
});

test('fixture refuses a status its operation does not document', async (t) => {
  const { client } = await setup(t, { responses: { 'agentWorkConventions.show': { status: 418, body: { message: 'teapot' } } } });
  assert.match((await client.conventions()).body.message, /does not document 418/);
});

test('fixture pair refuses an unknown connection', async (t) => {
  const { client } = await setup(t);
  assert.deepEqual((await client.pair('nope')).body.code, 'pair_target_unavailable');
});

test('fixture IdP: register, authorize with PKCE, token', async (t) => {
  const server = await startFixtureServer();
  t.after(() => server.close());
  const reg = await fetch(`${server.url}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude Code (eocrm plugin)', redirect_uris: ['http://127.0.0.1:53682/callback'] }),
  });
  assert.equal(reg.status, 201);
  assert.equal((await reg.json()).client_id, 'fixture-client');
  const verifier = 'v'.repeat(43);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const redirect = 'http://127.0.0.1:53682/callback';
  const auth = await fetch(`${server.url}/oauth/authorize?${new URLSearchParams({ client_id: 'fixture-client', redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st', scope: 'agent:runs', response_type: 'code' })}`, { redirect: 'manual' });
  const to = new URL(auth.headers.get('location'));
  assert.equal(to.searchParams.get('state'), 'st');
  const token = (v) => fetch(`${server.url}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'fixture-client', code: to.searchParams.get('code'), code_verifier: v, redirect_uri: redirect }),
  });
  assert.equal((await token('w'.repeat(43))).status, 400);
  const auth2 = await fetch(`${server.url}/oauth/authorize?${new URLSearchParams({ client_id: 'fixture-client', redirect_uri: redirect, code_challenge: challenge, state: 'st' })}`, { redirect: 'manual' });
  to.searchParams.set('code', new URL(auth2.headers.get('location')).searchParams.get('code'));
  const ok = await token(verifier);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).access_token, server.auth.access);
});

const STALE = { access_token: 'stale', refresh_token: 'fixture-refresh-0', expires_at: 0, client_id: 'fixture-client' };

test('a refresh answered 5xx or 429 is transient, never the 401', async (t) => {
  for (const status of [500, 503, 429]) {
    const { client, store } = await setup(t, { tokens: { ...STALE }, responses: { 'oauth.token': { status, body: { message: 'busy' } } } });
    assert.deepEqual(await client.conventions(), { status, body: null });
    assert.equal(store.sets, 0);
  }
});

test('a refresh answered 401 returns the original 401', async (t) => {
  const { client } = await setup(t, { tokens: { ...STALE }, responses: { 'oauth.token': { status: 401, body: { error: 'invalid_client' } } } });
  assert.deepEqual((await client.conventions()).body, { message: 'Unauthenticated.' });
});

test('an unexpected refresh answer is a network-class error', async (t) => {
  for (const r of [{ status: 404, body: { message: 'x' } }, { status: 200, body: { nope: 1 } }]) {
    const { client } = await setup(t, { tokens: { ...STALE }, responses: { 'oauth.token': r } });
    await assert.rejects(client.conventions(), (e) => e instanceof NetworkError && /oauth\/token/.test(e.message));
  }
});

test('redirects are refused, not followed', async (t) => {
  const target = await startFixtureServer();
  t.after(() => target.close());
  const hop = createServer((_req, res) => res.writeHead(302, { location: `${target.url}/acme/api/v1/agent-work/conventions` }).end());
  await new Promise((r) => hop.listen(0, '127.0.0.1', r));
  t.after(() => hop.close());
  const url = `http://127.0.0.1:${hop.address().port}`;
  const ep = endpoints({ region: 'eu', env: { EOCRM_ENDPOINTS: JSON.stringify({ issuer: url, api: `${url}/{workspace}/api` }) } });
  const client = createClient({ endpoints: ep, workspace: 'acme', store: memoryStore({ ...STALE, access_token: target.auth.access }) });
  await assert.rejects(client.conventions(), NetworkError);
  assert.equal(target.requests.length, 0);
});

test('response bodies are capped', async (t) => {
  const reply = (body, headers) => async () => new Response(body, { status: 200, headers });
  const ok = await setup(t, { fetch: reply(`"${'x'.repeat(MAX_BODY - 2)}"`) });
  assert.equal((await ok.client.conventions()).body.length, MAX_BODY - 2);
  const big = await setup(t, { fetch: reply('x'.repeat(MAX_BODY + 1)) });
  await assert.rejects(big.client.conventions(), (e) => e instanceof NetworkError && /too large/.test(e.message));
  const declared = await setup(t, { fetch: reply('{}', { 'content-length': String(MAX_BODY + 1) }) });
  await assert.rejects(declared.client.conventions(), (e) => e instanceof NetworkError && /too large/.test(e.message));
});

test('fixture validates path and query parameters', async (t) => {
  const { client } = await setup(t);
  const { body: run } = await client.startRun({ client_run_id: 's1' });
  const r = await client.listEvents(run.id, 'c'.repeat(201));
  assert.equal(r.status, 422);
  assert.ok(r.body.errors.cursor);
  assert.equal((await client.listEvents(run.id, 'c'.repeat(200))).status, 200);
});

test('a refresh answer without expires_in saves an unknown expiry', async (t) => {
  const { client, store } = await setup(t, {
    tokens: { access_token: 'stale', refresh_token: 'fixture-refresh-0', expires_at: 0, client_id: 'fixture-client' },
    responses: { 'oauth.token': () => ({ status: 200, body: { token_type: 'Bearer', access_token: 'fixture-access-0', refresh_token: 'r1' } }) },
  });
  assert.equal((await client.conventions()).status, 200);
  assert.equal((await store.get()).expires_at, null);
});

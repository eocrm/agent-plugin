import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { login, LoginError } from '../../lib/login.mjs';
import { credentialStore } from '../../lib/credentials.mjs';
import { endpoints } from '../../lib/endpoints.mjs';
import { startFixtureServer } from '../support/fixture-server.mjs';

const browse = (url) => { fetch(url).catch(() => {}); };

async function setup(t, { responses } = {}) {
  const server = await startFixtureServer({ responses });
  t.after(() => server.close());
  const data = mkdtempSync(join(tmpdir(), 'eocrm-login-'));
  const store = credentialStore({ data, platform: 'none' });
  const key = endpoints({ region: 'eu', env: server.endpointsEnv }).key;
  const run = (opts = {}) => login({ data, region: 'eu', workspace: 'acme', env: server.endpointsEnv, openBrowser: browse, store, timeoutMs: 5000, ...opts });
  const calls = (method, path) => server.requests.filter((r) => r.method === method && r.path === path);
  return { server, data, store, key, run, calls };
}

test('registers once, signs in with PKCE S256 and stores tokens under the endpoints key', async (t) => {
  const { server, data, store, key, run, calls } = await setup(t);
  const result = await run();

  const [register] = calls('POST', '/oauth/register');
  assert.deepEqual(register.body, {
    client_name: 'Claude Code (eocrm plugin)',
    redirect_uris: [53682, 53683, 53684].map((p) => `http://127.0.0.1:${p}/callback`),
  });
  const [authorize] = calls('GET', '/oauth/authorize');
  const [token] = calls('POST', '/oauth/token');
  assert.equal(authorize.query.scope, 'agent:runs');
  assert.equal(authorize.query.code_challenge_method, 'S256');
  assert.equal(authorize.query.response_type, 'code');
  assert.equal(authorize.query.client_id, 'fixture-client');
  assert.equal(authorize.query.redirect_uri, 'http://127.0.0.1:53682/callback');
  assert.equal(authorize.query.code_challenge.length, 43);
  assert.equal(authorize.query.code_challenge, createHash('sha256').update(token.body.code_verifier).digest('base64url'));
  assert.ok(authorize.query.state.length >= 32);
  assert.equal(token.body.redirect_uri, authorize.query.redirect_uri);

  assert.deepEqual(result, {
    workspace: 'acme',
    storage: 'file',
    pairing: { status: 'requested', approveUrl: 'https://workspace.example.test/account/agents' },
  });
  const saved = await store.get(key);
  assert.equal(saved.access_token, server.auth.access);
  assert.equal(saved.client_id, 'fixture-client');
  const account = JSON.parse(readFileSync(join(data, 'account.json'), 'utf8'));
  assert.deepEqual({ ...account, workspaces: undefined }, { region: 'eu', issuer: server.url, clientId: 'fixture-client', workspace: 'acme', workspaces: undefined });
  assert.equal(account.workspaces.acme, 'requested');
  await assert.rejects(fetch('http://127.0.0.1:53682/start'), 'the callback server closes after one valid callback');
});

const refusedOn = (host, port) => new Promise((resolve) => {
  const socket = connect({ host, port });
  socket.on('connect', () => { socket.destroy(); resolve(false); });
  socket.on('error', () => resolve(true));
});

test('the callback server listens on 127.0.0.1 only', async (t) => {
  const { run } = await setup(t);
  let refused;
  await run({ openBrowser: async (url) => {
    refused = await refusedOn('::1', new URL(url).port);
    browse(url);
  } });
  assert.equal(refused, true);
});

test('a second sign-in reuses the client registration, and a live token skips the browser', async (t) => {
  const { store, key, run, calls } = await setup(t);
  await run();
  let opened = 0;
  await run({ openBrowser: (u) => { opened += 1; browse(u); } });
  assert.equal(opened, 0);
  await store.del(key);
  await run({ openBrowser: (u) => { opened += 1; browse(u); } });
  assert.equal(opened, 1);
  assert.equal(calls('POST', '/oauth/register').length, 1);
  assert.equal(calls('GET', '/oauth/authorize').length, 2);
});

test('a callback with the wrong state is refused and nothing is stored', async (t) => {
  const { data, store, key, run, calls } = await setup(t);
  let refused;
  const wrongState = async (url) => {
    const res = await fetch(new URL('/callback?code=evil&state=wrong', url));
    refused = res.status;
  };
  await assert.rejects(run({ openBrowser: wrongState, timeoutMs: 400 }), (e) => e instanceof LoginError && e.exitCode === 3 && /timed out/.test(e.message));
  assert.equal(refused, 400);
  assert.equal(calls('POST', '/oauth/token').length, 0);
  assert.equal(await store.get(key), null);
  assert.equal(existsSync(join(data, 'credentials.json')), false);
});

test('a callback addressed to another host name is refused', async (t) => {
  const { run } = await setup(t);
  let status;
  const rebound = (url) => new Promise((resolve) => {
    const u = new URL(url);
    request({ host: '127.0.0.1', port: u.port, path: '/start', headers: { host: `evil.test:${u.port}` } }, (res) => {
      status = res.statusCode;
      res.resume();
      resolve();
    }).end();
  });
  await assert.rejects(run({ openBrowser: rebound, timeoutMs: 400 }), /timed out/);
  assert.equal(status, 400);
});

test('a cancelled consent fails sign-in', async (t) => {
  const { run } = await setup(t);
  const cancel = async (url) => {
    const start = await fetch(url, { redirect: 'manual' });
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    await fetch(new URL(`/callback?error=access_denied&state=${state}`, url));
  };
  await assert.rejects(run({ openBrowser: cancel }), (e) => e.exitCode === 3 && /cancelled/.test(e.message));
});

test('a busy 53682 makes login bind 53683', async (t) => {
  const blocker = createServer();
  await new Promise((r) => blocker.listen(53682, '127.0.0.1', r));
  t.after(() => new Promise((r) => blocker.close(r)));
  const { run, calls } = await setup(t);
  await run();
  assert.equal(calls('GET', '/oauth/authorize')[0].query.redirect_uri, 'http://127.0.0.1:53683/callback');
});

for (const status of [404, 403]) {
  test(`conventions ${status} fails with "workspace not found or Agent work is off"`, async (t) => {
    const { run } = await setup(t, { responses: { 'agentWorkConventions.show': { status, body: { message: 'x' } } } });
    await assert.rejects(run(), (e) => e.exitCode === 3 && e.message === 'workspace not found or Agent work is off');
  });
}

const pairable = (items) => ({ 'agentRun.pairable': { status: 200, body: { items } } });
const conn = (n) => ({ id: `01JZ00000000000000000000${n}0`, label: `Claude Code ${n}`, created_at: '2026-10-30T09:00:00+00:00' });

test('pairing: no candidates stands alone', async (t) => {
  const { run, calls } = await setup(t, { responses: pairable([]) });
  assert.deepEqual((await run()).pairing, { status: 'standalone' });
  assert.equal(calls('POST', '/v1/agent-runs/pair').length, 0);
});

test('pairing: one candidate is paired and awaits approval', async (t) => {
  const { run, calls } = await setup(t);
  const { pairing } = await run();
  assert.deepEqual(pairing, { status: 'requested', approveUrl: 'https://workspace.example.test/account/agents' });
  assert.deepEqual(calls('POST', '/v1/agent-runs/pair')[0].body, { connection_id: '01JZ0000000000000000000002' });
});

test('pairing: two candidates ask the member, without pairing', async (t) => {
  const { run, calls } = await setup(t, { responses: pairable([conn(1), conn(2)]) });
  assert.deepEqual((await run()).pairing, { status: 'choose', candidates: [conn(1), conn(2)] });
  assert.equal(calls('POST', '/v1/agent-runs/pair').length, 0);
});

test('pairing: a coded 422 stands alone and names the code', async (t) => {
  const { run } = await setup(t, { responses: { 'agentRun.pair': { status: 422, body: { code: 'pair_request_unavailable', message: 'A pairing request is already waiting for approval.' } } } });
  assert.deepEqual((await run()).pairing, { status: 'standalone', refused: 'pair_request_unavailable' });
});

const workspaces = (items) => ({ 'agentWork.workspaces': { status: 200, body: { items } } });

test('without a slug the only workspace with Agent work on is picked silently', async (t) => {
  const { run, calls } = await setup(t, { responses: workspaces([{ slug: 'acme', name: 'Acme', agent_work: true }, { slug: 'off', name: 'Off', agent_work: false }]) });
  assert.equal((await run({ workspace: undefined })).workspace, 'acme');
  assert.equal(calls('GET', '/v1/agent-work/workspaces')[0].workspace, null);
  assert.equal(calls('GET', '/v1/agent-work/conventions')[0].workspace, 'acme');
});

test('without a slug and several workspaces, login lists them and asks', async (t) => {
  const { data, run } = await setup(t, { responses: workspaces([{ slug: 'acme', name: 'Acme', agent_work: true }, { slug: 'beta', name: 'Beta', agent_work: true }]) });
  await assert.rejects(run({ workspace: undefined }), (e) => e.exitCode === 2 && e.message === 'workspace required'
    && e.lines.join('\n') === 'workspace acme Acme\nworkspace beta Beta');
  assert.equal(JSON.parse(readFileSync(join(data, 'account.json'), 'utf8')).workspace, undefined);
});

test('without a slug on an eocrm that has no workspace list, login asks for the slug', async (t) => {
  const { run } = await setup(t, { responses: { 'agentWork.workspaces': { status: 404, body: { message: 'Not Found' } } } });
  await assert.rejects(run({ workspace: undefined }), (e) => e.exitCode === 2 && e.message === 'workspace required');
});

test('without a slug and no workspace with Agent work on, login fails', async (t) => {
  const { run } = await setup(t, { responses: workspaces([{ slug: 'off', name: 'Off', agent_work: false }]) });
  await assert.rejects(run({ workspace: undefined }), (e) => e.exitCode === 3 && e.message === 'workspace not found or Agent work is off');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { login, LoginError, PORTS } from '../../lib/login.mjs';
import { credentialStore } from '../../lib/credentials.mjs';
import { endpoints } from '../../lib/endpoints.mjs';
import { startFixtureServer } from '../support/fixture-server.mjs';
import { main } from '../../scripts/eocrm.mjs';
import { userAgent } from '../../lib/api.mjs';

const browse = (url) => { fetch(url).catch(() => fetch(url)).catch(() => {}); };

async function freePorts(n) {
  const servers = await Promise.all(Array.from({ length: n }, () => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => r(s)); })));
  const ports = servers.map((s) => s.address().port);
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return ports;
}

async function setup(t, { responses } = {}) {
  const server = await startFixtureServer({ responses });
  t.after(() => server.close());
  const data = mkdtempSync(join(tmpdir(), 'eocrm-login-'));
  const store = credentialStore({ data, platform: 'none' });
  const key = endpoints({ region: 'eu', env: server.endpointsEnv }).key;
  const ports = await freePorts(3);
  const run = (opts = {}) => login({ data, region: 'eu', workspace: 'acme', env: server.endpointsEnv, openBrowser: browse, store, timeoutMs: 30000, ports, ...opts });
  const calls = (method, path) => server.requests.filter((r) => r.method === method && r.path === path);
  return { server, data, store, key, run, calls, ports };
}

test('registers once, signs in with PKCE S256 and stores tokens under the endpoints key', async (t) => {
  const { server, data, store, key, run, calls, ports } = await setup(t);
  assert.deepEqual(PORTS, [53682, 53683, 53684]);
  const result = await run();

  const [register] = calls('POST', '/oauth/register');
  assert.deepEqual(register.body, {
    client_name: 'Claude Code (eocrm plugin)',
    redirect_uris: ports.map((p) => `http://127.0.0.1:${p}/callback`),
  });
  const [authorize] = calls('GET', '/oauth/authorize');
  const [token] = calls('POST', '/oauth/token');
  assert.equal(authorize.query.scope, 'agent:runs');
  assert.equal(authorize.query.code_challenge_method, 'S256');
  assert.equal(authorize.query.response_type, 'code');
  assert.equal(authorize.query.client_id, 'fixture-client');
  assert.equal(authorize.query.redirect_uri, `http://127.0.0.1:${ports[0]}/callback`);
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
  assert.deepEqual({ ...account, workspaces: undefined, signedInAt: undefined }, { region: 'eu', issuer: server.url, clients: { [server.url]: 'fixture-client' }, keys: [key], workspace: 'acme', workspaces: undefined, signedInAt: undefined });
  assert.ok(account.signedInAt <= Date.now());
  assert.equal(saved.expires_at > Date.now() / 1000, true);
  assert.equal(account.workspaces.acme, 'requested');
  await assert.rejects(fetch(`http://127.0.0.1:${ports[0]}/start`), 'the callback server closes after one valid callback');
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
  let browsed;
  const wrongState = (url) => {
    browsed = fetch(new URL('/callback?code=evil&state=wrong', url)).then((res) => {
      refused = res.status;
    });
  };
  await assert.rejects(run({ openBrowser: wrongState, timeoutMs: 2000 }), (e) => e instanceof LoginError && e.exitCode === 3 && /timed out/.test(e.message));
  await browsed;
  assert.equal(refused, 400);
  assert.equal(calls('POST', '/oauth/token').length, 0);
  assert.equal(await store.get(key), null);
  assert.equal(existsSync(join(data, 'credentials.json')), false);
});

test('a callback addressed to another host name is refused', async (t) => {
  const { run } = await setup(t);
  let status;
  let browsed;
  const rebound = (url) => {
    browsed = new Promise((resolve, reject) => {
      const u = new URL(url);
      request({ host: '127.0.0.1', port: u.port, path: '/start', headers: { host: `evil.test:${u.port}` } }, (res) => {
        status = res.statusCode;
        res.resume();
        resolve();
      }).on('error', reject).end();
    });
  };
  await assert.rejects(run({ openBrowser: rebound, timeoutMs: 2000 }), /timed out/);
  await browsed;
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

test('a busy first port makes login bind the second', async (t) => {
  const { run, calls, ports } = await setup(t);
  const blocker = createServer();
  await new Promise((r) => blocker.listen(ports[0], '127.0.0.1', r));
  t.after(() => new Promise((r) => blocker.close(r)));
  await run();
  assert.equal(calls('GET', '/oauth/authorize')[0].query.redirect_uri, `http://127.0.0.1:${ports[1]}/callback`);
});

test('a coded 403 names its code', async (t) => {
  const { run } = await setup(t, { responses: { 'agentWorkConventions.show': { status: 403, body: { code: 'mcp_disabled', message: 'off' } } } });
  await assert.rejects(run(), (e) => e.exitCode === 3 && e.message === 'workspace not found or Agent work is off (mcp_disabled)');
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

const pairRefusal = (code) => ({ 'agentRun.pair': { status: 422, body: { code, message: 'm' } } });

test('pairing: an unavailable target stands alone and names the code', async (t) => {
  const { run } = await setup(t, { responses: pairRefusal('pair_target_unavailable') });
  assert.deepEqual((await run()).pairing, { status: 'standalone', refused: 'pair_target_unavailable' });
});

test('pairing: an already waiting request reads as requested', async (t) => {
  const { run } = await setup(t, { responses: pairRefusal('pair_request_unavailable') });
  assert.deepEqual((await run()).pairing, { status: 'requested', approveUrl: null });
});

test('pairing: an existing pairing reads as paired', async (t) => {
  const { run } = await setup(t, { responses: pairRefusal('agent_already_paired') });
  assert.deepEqual((await run()).pairing, { status: 'paired' });
});

const workspaces = (items) => ({ 'agentWork.workspaces': { status: 200, body: { items } } });

test('without a slug the only workspace with Agent work on is picked silently', async (t) => {
  const { run, calls } = await setup(t, { responses: workspaces([{ slug: 'acme', name: 'Acme', agent_work: true }, { slug: 'off', name: 'Off', agent_work: false }]) });
  assert.equal((await run({ workspace: undefined })).workspace, 'acme');
  assert.equal(calls('GET', '/v1/agent-work/workspaces')[0].workspace, null);
  assert.equal(calls('GET', '/v1/agent-work/conventions')[0].workspace, 'acme');
});

test('without a slug and several workspaces, login lists them and asks', async (t) => {
  const { data, run } = await setup(t, { responses: workspaces([{ slug: 'acme', name: 'Acme', agent_work: true }, { slug: 'beta', name: 'Be\u001bta', agent_work: true }]) });
  await assert.rejects(run({ workspace: undefined }), (e) => e.exitCode === 2 && e.message === 'workspace required'
    && e.lines.join('\n') === 'workspace acme Acme\nworkspace beta Be ta');
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

const raw = (port, line, host = `127.0.0.1:${port}`) => new Promise((resolve) => {
  const socket = connect({ host: '127.0.0.1', port });
  let got = '';
  socket.on('data', (d) => { got += d; });
  socket.on('error', () => resolve(got));
  socket.on('close', () => resolve(got));
  socket.write(`GET ${line} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
});

test('malformed callbacks get a 400 and sign-in still completes', async (t) => {
  const { run } = await setup(t);
  const answers = [];
  const result = await run({ openBrowser: async (url) => {
    const port = new URL(url).port;
    const wide = await fetch(new URL(`/callback?code=x&state=${'é'.repeat(43)}`, url));
    answers.push(`${wide.status} ${(await wide.text()).trim()}`);
    for (const line of ['http://[', 'http://a:99999/', 'http://%zz', `http://127.0.0.1:${port}/start`, '//[']) answers.push((await raw(port, line)).split(' ')[1]);
    browse(url);
  } });
  assert.deepEqual(answers, ['400 This sign-in link is not valid.', '400', '400', '400', '400', '400']);
  assert.equal(result.workspace, 'acme');
});

const tokenOnce = (server, first) => {
  let n = 0;
  return () => (n++ === 0 || first === 'always'
    ? { status: 401, body: { error: 'invalid_client', error_description: 'Client authentication failed', message: 'Client authentication failed' } }
    : { status: 200, body: { token_type: 'Bearer', expires_in: 3600, access_token: server().auth.access, refresh_token: server().auth.refresh } });
};

test('an invalid_client token answer registers again once', async (t) => {
  let server;
  const ctx = await setup(t, { responses: { 'oauth.token': tokenOnce(() => server) } });
  server = ctx.server;
  assert.equal((await ctx.run()).workspace, 'acme');
  assert.equal(ctx.calls('POST', '/oauth/register').length, 2);
  assert.equal(ctx.calls('GET', '/oauth/authorize').length, 2);
});

test('an invalid_client after registering again fails clearly', async (t) => {
  let server;
  const ctx = await setup(t, { responses: { 'oauth.token': tokenOnce(() => server, 'always') } });
  server = ctx.server;
  await assert.rejects(ctx.run(), (e) => e.exitCode === 3 && e.message === 'sign-in failed (invalid_client after registering again)');
  assert.equal(ctx.calls('POST', '/oauth/register').length, 2);
});

test('an invalid_client callback from authorize registers again once', async (t) => {
  let n = 0;
  const ctx = await setup(t, { responses: { 'oauth.authorize': ({ query }) => {
    if (n++ > 0) return undefined;
    const to = new URL(query.redirect_uri);
    to.search = new URLSearchParams({ error: 'invalid_client', state: query.state }).toString();
    return { status: 302, location: to.href };
  } } });
  assert.equal((await ctx.run()).workspace, 'acme');
  assert.equal(ctx.calls('POST', '/oauth/register').length, 2);
});

test('a token answer without expires_in stores an unknown expiry', async (t) => {
  let server;
  const ctx = await setup(t, { responses: { 'oauth.token': () => ({ status: 200, body: { token_type: 'Bearer', access_token: server.auth.access, refresh_token: server.auth.refresh } }) } });
  server = ctx.server;
  await ctx.run();
  assert.equal((await ctx.store.get(ctx.key)).expires_at, null);
});

test('each issuer keeps its own client: eu, ru, eu registers twice in all', async (t) => {
  const eu = await startFixtureServer();
  const ru = await startFixtureServer();
  t.after(() => Promise.all([eu.close(), ru.close()]));
  const data = mkdtempSync(join(tmpdir(), 'eocrm-login-'));
  const store = credentialStore({ data, platform: 'none' });
  const ports = await freePorts(3);
  const go = (region, server) => login({ data, region, workspace: 'acme', env: server.endpointsEnv, openBrowser: browse, store, timeoutMs: 30000, ports });
  await go('eu', eu);
  await go('ru', ru);
  await store.del(endpoints({ region: 'eu', env: eu.endpointsEnv }).key);
  await go('eu', eu);
  const registers = (s) => s.requests.filter((r) => r.path === '/oauth/register').length;
  assert.deepEqual([registers(eu), registers(ru)], [1, 1]);
  const account = JSON.parse(readFileSync(join(data, 'account.json'), 'utf8'));
  assert.deepEqual(account.clients, { [eu.url]: 'fixture-client', [ru.url]: 'fixture-client' });
  assert.equal(account.keys.length, 2);

  const out = [];
  assert.equal(await main({ argv: ['logout', '--data', data], env: eu.endpointsEnv, store, out: (l) => out.push(l), err: () => {} }), 0);
  assert.deepEqual(out.sort(), [`signed out of ${eu.url}`, `signed out of ${ru.url}`].sort());
  for (const s of [eu, ru]) assert.equal(await store.get(endpoints({ region: 'eu', env: s.endpointsEnv }).key), null);
});

test('the login requests carry the plugin User-Agent', async (t) => {
  const { server, run } = await setup(t);
  await run();
  const ours = server.requests.filter((r) => r.path !== '/oauth/authorize');
  assert.ok(ours.some((r) => r.path === '/oauth/register') && ours.some((r) => r.path === '/oauth/token'));
  assert.deepEqual([...new Set(ours.map((r) => r.headers['user-agent']))], [userAgent()]);
});

test('a codex login sends the codex User-Agent on every request', async (t) => {
  const { server, run } = await setup(t);
  await run({ harness: 'codex' });
  const ours = server.requests.filter((r) => r.path !== '/oauth/authorize');
  assert.ok(ours.some((r) => r.path === '/oauth/register') && ours.some((r) => r.path === '/oauth/token') && ours.some((r) => r.path.startsWith('/v1/')));
  assert.deepEqual([...new Set(ours.map((r) => r.headers['user-agent']))], [userAgent('codex')]);
});

import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { endpoints as regionEndpoints, SLUG } from './endpoints.mjs';
import { createClient } from './api.mjs';
import { credentialStore } from './credentials.mjs';
import { readJson, writeJsonAtomic } from './state.mjs';
import { accountFile, loadAccount } from './workspace.mjs';

export const PORTS = [53682, 53683, 53684];
export const CLIENT_NAME = 'Claude Code (eocrm plugin)';
const NOT_FOUND = 'workspace not found or Agent work is off';

export class LoginError extends Error {
  constructor(message, exitCode = 3, lines = []) {
    super(message);
    this.name = 'LoginError';
    this.exitCode = exitCode;
    this.lines = lines;
  }
}

const isWsl = () => {
  try {
    return readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
};

export function openBrowser(url, { platform = process.platform, wsl = platform === 'linux' && isWsl(), spawn = nodeSpawn, print = (l) => process.stdout.write(`${l}\n`) } = {}) {
  print(`open ${url} to sign in`);
  const launch = (cmd, args, fallback) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
      child.on('error', () => fallback?.());
      child.unref();
    } catch {
      fallback?.();
    }
  };
  if (platform === 'darwin') launch('open', [url]);
  else if (platform === 'win32') launch('rundll32', ['url.dll,FileProtocolHandler', url]);
  else if (wsl) launch('wslview', [url], () => launch('cmd.exe', ['/c', 'start', '""', url]));
  else launch('xdg-open', [url]);
}

async function post(url, body, form = false) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: { accept: 'application/json', 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    throw new LoginError(`POST ${new URL(url).pathname} failed (network error)`);
  }
}

async function listen(server) {
  for (const port of PORTS) {
    try {
      await new Promise((ok, fail) => {
        server.once('error', fail);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', fail);
          ok();
        });
      });
      return port;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  throw new LoginError(`ports ${PORTS.join(', ')} are busy`);
}

const same = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function page(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(`${text}\n`);
}

// The printed URL is the local /start redirect, so the state never reaches the terminal.
async function authorize({ issuer, clientId, open, timeoutMs }) {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const server = createServer();
  const port = await listen(server);
  const host = `127.0.0.1:${port}`;
  const redirect = `http://${host}/callback`;
  const url = new URL(`${issuer}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    scope: 'agent:runs',
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();
  let timer;
  try {
    const code = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new LoginError('sign-in timed out')), timeoutMs);
      server.on('request', (req, res) => {
        const u = new URL(req.url, redirect);
        // A rebound DNS name reaching this port is not the browser we opened.
        if (req.method !== 'GET' || req.headers.host !== host) return page(res, 400, 'Not a sign-in request.');
        if (u.pathname === '/start') return res.writeHead(302, { location: url.href, 'cache-control': 'no-store' }).end();
        if (u.pathname !== '/callback' || !same(u.searchParams.get('state'), state)) return page(res, 400, 'This sign-in link is not valid.');
        const got = u.searchParams.get('code');
        page(res, got ? 200 : 400, got ? 'Signed in to eocrm. You can close this tab.' : 'Sign-in was cancelled.');
        if (got) resolve(got);
        else reject(new LoginError('sign-in was cancelled'));
      });
      Promise.resolve().then(() => open(`http://${host}/start`)).catch(() => {});
    });
    return { code, verifier, redirect };
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}

async function signIn({ issuer, account, data, open, timeoutMs }) {
  if (!account.clientId) {
    const r = await post(`${issuer}/oauth/register`, { client_name: CLIENT_NAME, redirect_uris: PORTS.map((p) => `http://127.0.0.1:${p}/callback`) });
    if (r.status !== 201 || typeof r.body?.client_id !== 'string') throw new LoginError(`client registration failed (status ${r.status})`);
    account.clientId = r.body.client_id;
    writeJsonAtomic(accountFile(data), account);
  }
  const { code, verifier, redirect } = await authorize({ issuer, clientId: account.clientId, open, timeoutMs });
  const r = await post(`${issuer}/oauth/token`, { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: account.clientId, code_verifier: verifier }, true);
  if (r.status !== 200 || typeof r.body?.access_token !== 'string') throw new LoginError(`sign-in failed (token status ${r.status})`);
  return {
    access_token: r.body.access_token,
    refresh_token: r.body.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (Number(r.body.expires_in) || 0),
    client_id: account.clientId,
  };
}

export async function requestPair(client, connectionId) {
  const r = await client.pair(connectionId);
  if (r.status === 202) return { status: 'requested', approveUrl: r.body?.approve_url };
  return { status: 'standalone', refused: typeof r.body?.code === 'string' ? r.body.code : `status ${r.status}` };
}

async function pairing(client) {
  const r = await client.pairable();
  if (r.status !== 200) return { status: 'standalone', refused: typeof r.body?.code === 'string' ? r.body.code : `status ${r.status}` };
  const candidates = Array.isArray(r.body?.items) ? r.body.items : [];
  if (candidates.length > 1) return { status: 'choose', candidates };
  return candidates.length ? requestPair(client, candidates[0].id) : { status: 'standalone' };
}

function pickWorkspace(r) {
  if (r.status === 404) throw new LoginError('workspace required', 2);
  if (r.status !== 200) throw new LoginError(`sign-in failed (status ${r.status})`);
  const on = (Array.isArray(r.body?.items) ? r.body.items : []).filter((w) => w?.agent_work === true && typeof w.slug === 'string' && SLUG.test(w.slug));
  if (!on.length) throw new LoginError(NOT_FOUND);
  if (on.length > 1) throw new LoginError('workspace required', 2, on.map((w) => `workspace ${w.slug} ${String(w.name ?? '').replace(/\s+/g, ' ')}`));
  return on[0].slug;
}

export function recordPairing(data, workspace, status) {
  const account = loadAccount(data);
  writeJsonAtomic(accountFile(data), { ...account, workspaces: { ...account.workspaces, [workspace]: status } });
}

export async function login({ data, region, workspace, env = process.env, openBrowser: open = openBrowser, timeoutMs = 300000, store = credentialStore({ data }) }) {
  if (!region) throw new LoginError('region required', 2);
  if (workspace != null && !SLUG.test(workspace)) throw new LoginError('invalid workspace slug', 2);
  let ep;
  try {
    ep = regionEndpoints({ region, env });
  } catch (e) {
    throw new LoginError(e.message.replace(/^eocrm: /, ''), 2);
  }
  const stored = loadAccount(data);
  const account = stored.issuer === ep.issuer ? stored : { region, issuer: ep.issuer };
  account.region = region;
  const client = (ws) => createClient({ endpoints: ep, workspace: ws ?? null, store });
  const probe = () => (workspace ? client(workspace).conventions() : client(null).workspaces());

  let storage = readJson(join(data, 'credentials.json'), {})[ep.key] ? 'file' : 'keychain';
  let first = (await store.get(ep.key))?.access_token ? await probe() : { status: 401 };
  if (first.status === 401) {
    storage = await store.set(ep.key, await signIn({ issuer: ep.issuer, account, data, open, timeoutMs }));
    first = await probe();
  }
  if (!workspace) {
    workspace = pickWorkspace(first);
    first = await client(workspace).conventions();
  }
  if (first.status === 404 || first.status === 403) throw new LoginError(NOT_FOUND);
  if (first.status !== 200) throw new LoginError(`sign-in failed (status ${first.status})`);

  const paired = await pairing(client(workspace));
  writeJsonAtomic(accountFile(data), { ...account, workspace, workspaces: { ...account.workspaces, [workspace]: paired.status } });
  return { workspace, storage, pairing: paired };
}

import { clean, scrub, LIMITS } from './scrub.mjs';
import { LockTimeout } from './state.mjs';

export class NetworkError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NetworkError';
  }
}

const START_TEXT = { branch: 255, worktree: 500, repo: 200 };
const EVENT_TEXT = {
  label: LIMITS.stepLabel,
  subject: LIMITS.commitSubject,
  repo: LIMITS.commitRepo,
  command: LIMITS.testCommand,
  result_line: LIMITS.resultLine,
  summary: LIMITS.findingSummary,
  what: LIMITS.rulingWhat,
  why: LIMITS.rulingWhy,
  cost_if_wrong: LIMITS.rulingCostIfWrong,
};
const PLAN_ITEM_TEXT = 500;
export const MAX_BODY = 1024 * 1024;

class TooLarge extends Error {}

async function readCapped(res) {
  if (Number(res.headers.get('content-length')) > MAX_BODY) throw new TooLarge();
  if (!res.body) return '';
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BODY) throw new TooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function cleaned(obj, limits) {
  const out = { ...obj };
  for (const [k, limit] of Object.entries(limits)) if (typeof out[k] === 'string') out[k] = clean(out[k], limit);
  return out;
}

function cleanEvent(event) {
  const out = cleaned(event, EVENT_TEXT);
  // A truncated URL fails eocrm's uri format, so the url is only scrubbed.
  if (typeof out.url === 'string') out.url = scrub(out.url);
  if (Array.isArray(out.items)) out.items = out.items.map((i) => cleaned(i, { text: PLAN_ITEM_TEXT }));
  return out;
}

export function createClient({ endpoints, workspace, store, fetch = globalThis.fetch, timeoutMs = 8000, lockTimeoutMs = 2500 }) {
  const base = endpoints.api(workspace);
  const { issuer, key } = endpoints;

  async function send(label, url, init) {
    try {
      const res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      const text = await readCapped(res);
      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      return { status: res.status, body };
    } catch (e) {
      const why = e?.name === 'TimeoutError' ? 'timeout' : e instanceof TooLarge ? 'response too large' : 'network error';
      throw new NetworkError(`eocrm: ${label} failed (${why})`);
    }
  }

  function once(method, path, json, access) {
    const headers = { accept: 'application/json', authorization: `Bearer ${access}` };
    if (json !== undefined) headers['content-type'] = 'application/json';
    return send(`${method} ${path.split('?')[0]}`, base + path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  }

  async function rotate(tokens, outcome) {
    if (!tokens.refresh_token || !tokens.client_id) return null;
    const r = await send('POST /oauth/token', `${issuer}/oauth/token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: tokens.client_id, refresh_token: tokens.refresh_token }).toString(),
    });
    if (r.status === 400 || r.status === 401) return null;
    if (r.status === 429 || r.status >= 500) {
      outcome.transient = { status: r.status, body: null };
      return null;
    }
    if (r.status !== 200 || typeof r.body?.access_token !== 'string') throw new NetworkError(`eocrm: POST /oauth/token failed (status ${r.status})`);
    return {
      access_token: r.body.access_token,
      refresh_token: r.body.refresh_token ?? tokens.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (Number(r.body.expires_in) || 0),
      client_id: tokens.client_id,
    };
  }

  // Refresh tokens rotate, so a refresh racing another process's would spend a revoked one.
  async function refresh(tokens, outcome) {
    const newer = (t) => (t?.access_token && t.access_token !== tokens.access_token ? t : null);
    try {
      return await store.update(key, async (latest) => newer(latest) ?? rotate(tokens, outcome), { timeoutMs: lockTimeoutMs });
    } catch (e) {
      if (!(e instanceof LockTimeout)) throw e;
      return newer(await store.get(key));
    }
  }

  async function call(method, path, json) {
    const tokens = await store.get(key);
    if (!tokens?.access_token) return { status: 401, body: null };
    const first = await once(method, path, json, tokens.access_token);
    if (first.status !== 401) return first;
    const outcome = {};
    const fresh = await refresh(tokens, outcome);
    return fresh ? once(method, path, json, fresh.access_token) : outcome.transient ?? first;
  }

  const run = (id) => `/v1/agent-runs/${encodeURIComponent(id)}`;

  return {
    startRun: (body) => call('POST', '/v1/agent-runs', cleaned(body, START_TEXT)),
    updateRun: (id, body) => call('PATCH', run(id), cleaned(body, { step: LIMITS.stepLabel })),
    heartbeat: (id) => call('POST', `${run(id)}/heartbeat`),
    recordEvents: (id, events) => call('POST', `${run(id)}/events`, { events: events.map(cleanEvent) }),
    listEvents: (id, cursor) => call('GET', `${run(id)}/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
    conventions: () => call('GET', '/v1/agent-work/conventions'),
    pairable: () => call('GET', '/v1/agent-runs/pairable'),
    pair: (connection_id) => call('POST', '/v1/agent-runs/pair', { connection_id }),
  };
}

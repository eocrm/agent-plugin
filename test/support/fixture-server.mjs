import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const snapshot = JSON.parse(readFileSync(new URL('../contract/openapi.agent.json', import.meta.url), 'utf8'));
const recorded = (name) => JSON.parse(readFileSync(new URL(`../contract/responses/${name}.json`, import.meta.url), 'utf8'));

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(snapshot, 'snap');

const esc = (s) => s.replace(/~/g, '~0').replace(/\//g, '~1');
const JSON_SCHEMA = `content/${esc('application/json')}/schema`;
// eocrm 0.19.5 answers 409 run_ended on PATCH and heartbeat but does not document it.
const UNDOCUMENTED = { 409: 'components/schemas/CodedRefusal' };
// Pending eocrm 0.19.6 (not in openapi.json yet): region-host route, shape of AgentWorkspaceListData.
const PENDING = {
  'agentWork.workspaces': ajv.compile({
    type: 'object', required: ['items'], additionalProperties: false,
    properties: { items: { type: 'array', items: { type: 'object', required: ['slug', 'name', 'agent_work'], additionalProperties: false, properties: { slug: { type: 'string' }, name: { type: 'string' }, agent_work: { type: 'boolean' } } } } },
  }),
};

const OPS = Object.entries(snapshot.paths)
  .flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({
    path, method: method.toUpperCase(), op, at: `paths/${esc(path)}/${method}`,
    re: new RegExp(`^${path.replace(/\{[^}]+\}/g, '([^/]+)')}$`),
  })))
  .sort((a, b) => a.path.includes('{') - b.path.includes('{'));

function responseError(entry, status, body) {
  if (status >= 500) return null;
  let pointer;
  if (entry) {
    let res = entry.op.responses[status];
    let at = `${entry.at}/responses/${status}`;
    if (res?.$ref) {
      at = res.$ref.slice(2);
      res = at.split('/').reduce((o, k) => o[k], snapshot);
    }
    if (res && !res.content) return body === undefined ? null : `${status} must have no body`;
    pointer = res ? `${at}/${JSON_SCHEMA}` : UNDOCUMENTED[status];
    if (!pointer) return `${entry.method} ${entry.path} does not document ${status}`;
  }
  if (!pointer) return null;
  const validate = ajv.getSchema(`snap#/${pointer}`);
  return validate(body) ? null : ajv.errorsText(validate.errors);
}

function laravelErrors(errors) {
  const out = {};
  for (const e of errors) {
    const key = e.instancePath.slice(1).replace(/\//g, '.') || e.params.missingProperty || 'body';
    (out[key] ??= []).push(e.message);
  }
  return out;
}

const now = () => new Date().toISOString();

export async function startFixtureServer({ responses = {}, messages = [] } = {}) {
  const requests = [];
  let n = 0;
  const auth = { clientId: 'fixture-client', access: 'fixture-access-0', refresh: 'fixture-refresh-0' };
  const codes = new Map();
  const runs = new Map();

  const tokenPair = () => {
    n += 1;
    auth.access = `fixture-access-${n}`;
    auth.refresh = `fixture-refresh-${n}`;
    return { status: 200, body: { token_type: 'Bearer', expires_in: 3600, access_token: auth.access, refresh_token: auth.refresh } };
  };
  const invalidGrant = { status: 400, body: { error: 'invalid_grant', error_description: 'The refresh token is invalid.', message: 'The refresh token is invalid.' } };
  const refused = (code, message, status) => ({ status, body: { code, message } });
  const noRun = { status: 404, body: { message: 'No query results for model [AgentRun].' } };

  const oauth = {
    'oauth.register': ({ body }) => ({
      status: 201,
      body: { ...recorded('oauth.register'), client_name: body?.client_name, redirect_uris: body?.redirect_uris ?? [] },
    }),
    'oauth.authorize': ({ query }) => {
      const code = randomBytes(8).toString('hex');
      codes.set(code, { challenge: query.code_challenge, redirect: query.redirect_uri, client: query.client_id });
      const to = new URL(query.redirect_uri);
      to.searchParams.set('code', code);
      if (query.state) to.searchParams.set('state', query.state);
      return { status: 302, location: to.href };
    },
    'oauth.token': ({ body }) => {
      if (body?.grant_type === 'refresh_token') {
        return body.refresh_token === auth.refresh && body.client_id === auth.clientId ? tokenPair() : invalidGrant;
      }
      const grant = body?.grant_type === 'authorization_code' && codes.get(body.code);
      codes.delete(body?.code);
      const challenge = grant && createHash('sha256').update(String(body.code_verifier)).digest('base64url');
      return grant && challenge === grant.challenge && body.redirect_uri === grant.redirect ? tokenPair() : invalidGrant;
    },
  };

  const api = {
    'agentRun.store': ({ body }) => {
      const existing = [...runs.values()].find((r) => r.client_run_id === body.client_run_id);
      if (existing) return { status: 200, body: existing.data };
      n += 1;
      const id = `01JZRUN${String(n).padStart(19, '0')}`;
      const data = { ...recorded('agentRun.store'), id, task_key: body.task ?? null, branch: body.branch ?? null, repo: body.repo ?? null, started_at: now(), last_heartbeat_at: now() };
      runs.set(id, { client_run_id: body.client_run_id, data, events: [] });
      return { status: 201, body: data };
    },
    'agentRun.update': ({ params: [id], body = {} }) => {
      const run = runs.get(id);
      if (!run) return noRun;
      const d = run.data;
      if (d.ended_at && (body.step !== undefined || (body.state !== undefined && body.state !== d.state))) {
        return refused('run_ended', 'This run has already ended.', 409);
      }
      if ('task' in body) d.task_key = body.task;
      if (body.step !== undefined) d.step = body.step;
      if (body.state !== undefined && body.state !== d.state) {
        d.state = body.state;
        if (body.state !== 'running') d.ended_at = now();
      }
      return { status: 200, body: d };
    },
    'agentRun.heartbeat': ({ params: [id] }) => {
      const run = runs.get(id);
      if (!run) return noRun;
      if (run.data.ended_at) return refused('run_ended', 'This run has already ended.', 409);
      run.data.last_heartbeat_at = now();
      return { status: 200, body: { messages: messages.splice(0) } };
    },
    'agentRun.events.store': ({ params: [id], body }) => {
      const run = runs.get(id);
      if (!run) return noRun;
      let accepted = 0;
      for (const { id: eventId, type, occurred_at, ...payload } of body.events) {
        if (run.events.some((e) => e.id === eventId)) continue;
        run.events.push({ id: eventId, type, occurred_at: occurred_at ?? now(), payload });
        accepted += 1;
      }
      return { status: 200, body: { accepted, duplicates: body.events.length - accepted, dropped: 0, ...(messages.length ? { messages: messages.splice(0) } : {}) } };
    },
    'agentRun.events.index': ({ params: [id], query }) => {
      const run = runs.get(id);
      if (!run) return noRun;
      const from = Number(query.cursor ?? 0);
      const next = from + 100 < run.events.length ? String(from + 100) : null;
      return { status: 200, body: { items: run.events.slice(from, from + 100), next_cursor: next } };
    },
    'agentWork.workspaces': () => ({ status: 200, body: { items: [{ slug: 'acme', name: 'Acme', agent_work: true }] } }),
    'agentWorkConventions.show': () => ({ status: 200, body: recorded('agentWorkConventions.show') }),
    'agentRun.pairable': () => ({ status: 200, body: recorded('agentRun.pairable') }),
    'agentRun.pair': ({ body }) => recorded('agentRun.pairable').items.some((c) => c.id === body.connection_id)
      ? { status: 202, body: recorded('agentRun.pair') }
      : refused('pair_target_unavailable', 'That connection cannot be paired.', 422),
  };

  function route(method, pathname) {
    const m = /^\/oauth\/(register|authorize|token)$/.exec(pathname);
    if (m) return { name: `oauth.${m[1]}`, workspace: null, path: pathname };
    if (method === 'GET' && pathname === '/api/v1/agent-work/workspaces') return { name: 'agentWork.workspaces', pending: true, workspace: null, path: '/v1/agent-work/workspaces' };
    const w = /^\/([^/]+)\/api(\/.*)$/.exec(pathname);
    if (!w) return null;
    for (const entry of OPS) {
      const p = entry.re.exec(w[2]);
      if (p && entry.method === method) return { name: entry.op.operationId, entry, workspace: w[1], path: w[2], params: p.slice(1).map(decodeURIComponent) };
    }
    return null;
  }

  function handle(req, raw) {
    const url = new URL(req.url, 'http://fixture');
    const type = req.headers['content-type'] ?? '';
    let body;
    if (raw.length) {
      try {
        body = type.includes('x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw);
      } catch {
        body = undefined;
      }
    }
    const query = Object.fromEntries(url.searchParams);
    const r = route(req.method, url.pathname);
    req.logged = { method: req.method, path: r?.path ?? url.pathname, workspace: r?.workspace ?? null, query, headers: req.headers, body };
    requests.push(req.logged);
    if (!r || (r.name.startsWith('oauth.') && req.method !== (r.name === 'oauth.authorize' ? 'GET' : 'POST'))) {
      return { status: 404, body: { message: 'Not Found' } };
    }
    const ctx = { body, query, params: r.params ?? [], headers: req.headers };
    if ((r.entry || r.pending) && req.headers.authorization !== `Bearer ${auth.access}`) return { status: 401, body: { message: 'Unauthenticated.' } };
    if (r.entry) {
      const names = [...r.entry.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      const errors = {};
      (r.entry.op.parameters ?? []).forEach((param, i) => {
        const value = param.in === 'path' ? ctx.params[names.indexOf(param.name)] : param.in === 'query' ? query[param.name] : undefined;
        const validate = ajv.getSchema(`snap#/${r.entry.at}/parameters/${i}/schema`);
        if (value === undefined ? param.required : !validate(value)) errors[param.name] = [value === undefined ? 'required' : ajv.errorsText(validate.errors)];
      });
      if (Object.keys(errors).length) return { status: 422, body: { message: 'The given data was invalid.', errors } };
      const rb = r.entry.op.requestBody;
      if (rb && (body !== undefined || rb.required)) {
        const validate = ajv.getSchema(`snap#/${r.entry.at}/requestBody/${JSON_SCHEMA}`);
        if (!validate(body)) return { status: 422, body: { message: 'The given data was invalid.', errors: laravelErrors(validate.errors) } };
      }
    }
    const override = responses[r.name];
    const result = (typeof override === 'function' ? override(ctx) : override) ?? (oauth[r.name] ?? api[r.name])(ctx);
    const pending = r.pending && result.status === 200 && !PENDING[r.name](result.body) ? ajv.errorsText(PENDING[r.name].errors) : null;
    const bad = pending ?? responseError(r.entry, result.status, result.body);
    return bad ? { status: 500, body: { message: `fixture response violates contract: ${bad}` } } : result;
  }

  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let result;
      try {
        result = handle(req, raw);
      } catch (e) {
        result = { status: 500, body: { message: `fixture error: ${e.message}` } };
      }
      const { status, body, location } = result;
      if (req.logged) Object.assign(req.logged, { status, response: body });
      const headers = location ? { location } : body === undefined ? {} : { 'content-type': 'application/json' };
      res.writeHead(status, headers).end(body === undefined ? undefined : JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    requests,
    auth,
    endpointsEnv: { EOCRM_ENDPOINTS: JSON.stringify({ issuer: url, api: `${url}/{workspace}/api` }) },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

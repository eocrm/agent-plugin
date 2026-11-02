import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataDir } from '../lib/paths.mjs';
import { endpoints } from '../lib/endpoints.mjs';
import { createClient } from '../lib/api.mjs';
import { credentialStore, spawnWithStdin } from '../lib/credentials.mjs';
import { login, openBrowser, requestPair, recordPairing, plain } from '../lib/login.mjs';
import { accountFile, loadAccount, resolveWorkspace, useWorkspace, answerCommitted, committedLine } from '../lib/workspace.mjs';
import { linkWorktree, runsOf, runClient } from '../lib/run.mjs';
import { loadConventions } from '../lib/reconcile.mjs';
import { enqueue } from '../lib/outbox.mjs';
import { eventId } from '../lib/ids.mjs';
import { worktreeOf, writeJsonAtomic, withLock, loadRun, saveRun } from '../lib/state.mjs';

const OPTIONS = { data: { type: 'string' }, region: { type: 'string' }, here: { type: 'boolean' }, accept: { type: 'boolean' }, decline: { type: 'boolean' }, what: { type: 'string' }, why: { type: 'string' }, 'cost-if-wrong': { type: 'string' }, severity: { type: 'string' }, summary: { type: 'string' }, outcome: { type: 'string' }, session: { type: 'string' }, repo: { type: 'string' } };
const SEVERITIES = ['critical', 'important', 'minor', 'theoretical'];
const OUTCOMES = ['open', 'fixed', 'accepted', 'disputed', 'dropped'];
const LINK_KEY = /^[A-Z][A-Z0-9]{1,9}-[0-9]+$/;
const CONVENTIONS_MS = 4000;
const APPROVE = 'pairing requested: approve in Account → Agents within 15 minutes';

class Usage extends Error {
  exitCode = 2;
}

function pairingLines(p) {
  if (p.status === 'requested') return [p.approveUrl ? `${APPROVE}: ${p.approveUrl}` : APPROVE];
  if (p.status === 'paired') return ['already paired'];
  if (p.status === 'choose') return ['pairing: choose a connection, then run pair <id>', ...p.candidates.map((c) => `connection ${plain(c.id)} ${plain(c.label).replace(/\s+/g, ' ')}`)];
  return [p.refused ? `running standalone (${p.refused})` : 'running standalone'];
}

// Without a matching --session, the most recently touched run.
function liveRun(data, cwd, session) {
  const live = runsOf(data, worktreeOf(cwd).key).filter((r) => !r.ended);
  const run = live.find((r) => r.sessionId === session) ?? live[0];
  if (!run) throw new Error('no active run in this worktree');
  return run;
}

const need = (v, name) => {
  if (typeof v !== 'string' || !v.trim()) throw new Usage(`--${name} required`);
  return v;
};

const commands = {
  async login({ values, positionals: [workspace], env, cwd, out, data, store, open }) {
    const result = await login({ data, region: values.region, workspace, env, store, openBrowser: (u) => open(u, { print: out }) });
    const lines = [`signed in to ${result.workspace} (${values.region})`];
    if (result.storage === 'file') lines.push(`tokens stored in ${join(data, 'credentials.json')}: no keychain found`);
    lines.push(...pairingLines(result.pairing));
    const { pending } = resolveWorkspace({ data, cwd });
    if (pending) lines.push(committedLine(pending));
    lines.forEach((l) => out(l));
  },

  async use({ values, positionals: [workspace], cwd, out, data }) {
    if (values.accept || values.decline) {
      const file = answerCommitted({ data, cwd, accepted: Boolean(values.accept) });
      out(values.accept ? `this repository uses ${file.workspace} (.claude/eocrm.json)` : 'this repository keeps your default workspace');
      return;
    }
    if (!workspace) throw new Usage('workspace required');
    useWorkspace({ data, cwd, workspace, here: values.here });
    out(values.here ? `this worktree uses ${workspace}` : `this repository uses ${workspace}`);
    if (!(workspace in (loadAccount(data).workspaces ?? {}))) out(`run /eocrm:login ${workspace}`);
  },

  async pair({ positionals: [id], env, cwd, out, data, store }) {
    if (!id) throw new Usage('connection id required');
    const { workspace, region } = resolveWorkspace({ data, cwd });
    if (!workspace || !region) throw new Usage('workspace required: run /eocrm:login first');
    const result = await requestPair(createClient({ endpoints: endpoints({ region, env }), workspace, store }), id);
    recordPairing(data, workspace, result.status);
    pairingLines(result).forEach((l) => out(l));
    return result.status === 'standalone' ? 3 : 0;
  },

  async status({ env, cwd, out, data, store }) {
    const account = loadAccount(data);
    const { workspace, region, source, pending } = resolveWorkspace({ data, cwd });
    const tokens = account.region ? await store.get(endpoints({ region: account.region, env }).key, { timeoutMs: 2500 }) : null;
    out(tokens?.access_token ? `signed in (${account.region})` : 'signed out: run /eocrm:login');
    if (!workspace) return;
    out(`workspace ${workspace} (${source})`);
    const known = account.workspaces?.[workspace];
    if (region !== account.region) out(`run /eocrm:login --region ${region} ${workspace}`);
    else if (!known) out(`run /eocrm:login ${workspace}`);
    else out(`pairing ${known}`);
    if (pending) out(committedLine(pending));
  },

  async link({ values, positionals: [answer], env, cwd, out, data, spawnFlush }) {
    if (answer !== 'none' && !LINK_KEY.test(answer ?? '')) throw new Usage('usage: eocrm link <KEY|none>');
    const taskKey = answer === 'none' ? null : answer;
    await linkWorktree({ data, env, now: Date.now, spawnFlush }, cwd, taskKey, values.session);
    out(taskKey ? `linked to ${taskKey}` : 'not linked to a task');
  },

  async record({ values: v, positionals: [kind], cwd, out, data }) {
    let type;
    let key;
    let fields;
    if (kind === 'ruling') {
      type = 'ruling';
      fields = { what: need(v.what, 'what'), why: need(v.why, 'why'), ...(v['cost-if-wrong'] ? { cost_if_wrong: v['cost-if-wrong'] } : {}) };
      key = `${fields.what}\0${fields.why}`;
    } else if (kind === 'finding') {
      type = 'review_finding';
      if (!SEVERITIES.includes(v.severity)) throw new Usage(`--severity must be ${SEVERITIES.join('|')}`);
      if (v.outcome !== undefined && !OUTCOMES.includes(v.outcome)) throw new Usage(`--outcome must be ${OUTCOMES.join('|')}`);
      fields = { severity: v.severity, summary: need(v.summary, 'summary'), ...(v.outcome ? { outcome: v.outcome } : {}) };
      key = `${fields.severity}\0${fields.summary}\0${fields.outcome ?? ""}`;
    } else throw new Usage('usage: eocrm record ruling|finding');
    const run = liveRun(data, cwd, v.session);
    const queued = await enqueue(data, { kind: 'event', sessionId: run.sessionId, event: { id: eventId(type, key), type, occurred_at: new Date().toISOString(), ...fields } });
    if (!queued) throw Object.assign(new Error(`${kind} not recorded: the local queue is unavailable`), { exitCode: 1 });
    out(`recorded ${kind}`);
  },

  async conventions({ values, env, cwd, out, data, store }) {
    const run = liveRun(data, cwd, values.session);
    let conventions = run.conventions;
    if (!conventions) {
      conventions = await loadConventions({}, run, runClient({ data, env, store })(run), Date.now() + CONVENTIONS_MS);
      if (!conventions) throw new Error('conventions unavailable: ask the member');
      await withLock(data, async () => {
        if (!loadRun(data, run.sessionId).conventions) saveRun(data, run.sessionId, { conventions });
      }, { giveUpMs: 1500 }).catch(() => {});
    }
    const compact = { workspace: run.workspace, ...conventions };
    delete compact.workflows;
    out(JSON.stringify(compact));
  },

  async logout({ env, out, data, store }) {
    const account = loadAccount(data);
    const keys = new Set(Array.isArray(account.keys) ? account.keys : []);
    if (account.region) keys.add(endpoints({ region: account.region, env }).key);
    const failed = [];
    for (const key of keys) {
      try {
        await store.del(key);
        out(`signed out of ${plain(String(key).split(' ')[0])}`);
      } catch {
        failed.push(key);
      }
    }
    writeJsonAtomic(accountFile(data), { ...account, keys: failed });
    if (failed.length) out('sign-out incomplete, run /eocrm:logout again');
    else if (!keys.size) out('signed out');
  },

  async 'smoke-seed'(ctx) {
    const { values, env, cwd, out, data, store, gh } = ctx;
    const repo = values.repo;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '')) throw new Usage('--repo <owner>/<repo> required');
    const account = loadAccount(data);
    const signIn = () => new Usage('sign in first: /eocrm:login');
    if (!account.region) throw signIn();
    const key = endpoints({ region: account.region, env }).key;
    const tokens = await store.get(key);
    if (!tokens?.refresh_token || !tokens.client_id) throw signIn();
    const { workspace } = resolveWorkspace({ data, cwd });
    const writes = [
      ['secret', 'EOCRM_SMOKE_REGION', account.region],
      ['secret', 'EOCRM_SMOKE_CLIENT_ID', tokens.client_id],
      ['secret', 'EOCRM_SMOKE_REFRESH_TOKEN', tokens.refresh_token],
      ...(workspace ? [['variable', 'EOCRM_SMOKE_WORKSPACE', workspace]] : []),
    ];
    for (const [kind, name, value] of writes) {
      const { code } = await gh([kind, 'set', name, '--repo', repo], value);
      if (code !== 0) {
        const e = new Error(code === -1 ? 'gh not found or timed out; local sign-in kept' : `gh ${kind} set ${name} failed (exit ${code}); local sign-in kept`);
        e.exitCode = 1;
        throw e;
      }
      out(`set ${name}`);
    }
    const gone = await store.del(key, { when: (t) => t?.refresh_token === tokens.refresh_token });
    if (gone === false) {
      const e = new Error('refresh token rotated while seeding; run smoke-seed again');
      e.exitCode = 1;
      throw e;
    }
    await commands.logout(ctx);
    out('signed out locally: the refresh token now belongs to CI');
  },
};

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  out = (l) => process.stdout.write(`${l}\n`),
  err = (l) => process.stderr.write(`${l}\n`),
  version = process.versions.node,
  store,
  openBrowser: open = openBrowser,
  spawnFlush,
  gh = (args, stdin) => spawnWithStdin('gh', args, stdin, { timeoutMs: 30000 }),
} = {}) {
  if (!(Number(String(version).split('.')[0]) >= 20)) {
    err('eocrm needs Node 20+ on PATH');
    return 1;
  }
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    const [name, ...rest] = positionals;
    const command = Object.hasOwn(commands, name) ? commands[name] : null;
    if (!command) throw new Usage('usage: eocrm login|use|pair|status|link|record|conventions|logout|smoke-seed --data <dir>');
    let data;
    try {
      data = dataDir({ argv, env, data: values.data });
    } catch (e) {
      throw new Usage(e.message);
    }
    const code = await command({ values, positionals: rest, env, cwd, out, data, store: store ?? credentialStore({ data }), open, spawnFlush, gh });
    return code ?? 0;
  } catch (e) {
    for (const line of e.lines ?? []) out(line);
    err(`eocrm: ${String(e.message).replace(/^eocrm: /, '')}`);
    return e.exitCode ?? (String(e.code).startsWith('ERR_PARSE_ARGS') ? 2 : 3);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}

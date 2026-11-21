import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dataDir, cliHarness, cliData, codexData, installData } from '../lib/paths.mjs';
import { endpoints } from '../lib/endpoints.mjs';
import { createClient } from '../lib/api.mjs';
import { storeFor, spawnWithStdin } from '../lib/credentials.mjs';
import { login, openBrowser, requestPair, recordPairing, pairing, plain } from '../lib/login.mjs';
import { accountFile, loadAccount, resolveWorkspace, useWorkspace, answerCommitted, committedLine, command as cmd, repoEntry, updateRepo, cloneEntry, updateClone } from '../lib/workspace.mjs';
import { AGENTS } from '../lib/cli/attribute.mjs';
import { hooksDir, hooksScope, install, installCopy, installed, launcherTarget, uninstall } from '../lib/cli/hooks.mjs';
import { agentFor, endStale, liveRuns, pluginLive, queuePr, runHook, startRun, stopRuns, sync } from '../lib/cli/run.mjs';
import { linkWorktree, runsOf, runClient, spawnFlush as realSpawnFlush } from '../lib/run.mjs';
import { loadConventions } from '../lib/reconcile.mjs';
import { enqueue } from '../lib/outbox.mjs';
import { eventId } from '../lib/ids.mjs';
import { taskFor } from '../lib/detect.mjs';
import { worktreeOf, lastHookAt, writeJsonAtomic, withLock, saveRun } from '../lib/state.mjs';
import { CHANGE_ID, importChanges, linkChange } from '../lib/cli/openspec.mjs';

const OPTIONS = { data: { type: 'string' }, device: { type: 'boolean' }, harness: { type: 'string' }, region: { type: 'string' }, here: { type: 'boolean' }, accept: { type: 'boolean' }, decline: { type: 'boolean' }, what: { type: 'string' }, why: { type: 'string' }, 'cost-if-wrong': { type: 'string' }, severity: { type: 'string' }, summary: { type: 'string' }, outcome: { type: 'string' }, session: { type: 'string' }, refresh: { type: 'boolean' }, repo: { type: 'string' }, agent: { type: 'string' }, quiet: { type: 'boolean' }, 'shared-hooks': { type: 'boolean' }, space: { type: 'string' } };
const SEVERITIES = ['critical', 'important', 'minor', 'theoretical'];
const OUTCOMES = ['open', 'fixed', 'accepted', 'disputed', 'dropped'];
const LINK_KEY = /^[A-Z][A-Z0-9]{1,9}-[0-9]+$/;
const CONVENTIONS_MS = 4000;
const TRUST = 'Hooks have not run here yet. In Codex, open /hooks and trust the eocrm hooks.';
const APPROVE = 'pairing requested: approve in Account → Agents within 15 minutes';
const LIVE = 'a Claude Code or Codex session is reporting this worktree';
const CLI_ONLY = (name) => `${name} is for the eocrm CLI (npx @eocrm/cli ${name})`;

class Usage extends Error {
  exitCode = 2;
}

function pairingLines(p) {
  if (p.status === 'requested') return [p.approveUrl ? `${APPROVE}: ${p.approveUrl}` : APPROVE];
  if (p.status === 'paired') return ['already paired'];
  if (p.status === 'choose') return ['pairing: choose a connection, then run pair <id>', ...p.candidates.map((c) => `connection ${plain(c.id)} ${plain(c.label).replace(/\s+/g, ' ')}`)];
  return [p.refused ? `running standalone (${p.refused})` : 'running standalone'];
}

async function recheck({ data, env, store, workspace, region, harness }) {
  try {
    const client = createClient({ endpoints: endpoints({ region, env }), workspace, store, harness });
    let result = await pairing(client);
    const target = loadAccount(data).pairTargets?.[workspace];
    if (result.status === 'choose') {
      if (!result.candidates.some((c) => c.id === target)) {
        if (target) recordPairing(data, workspace, 'requested');
        return pairingLines(result);
      }
      result = await requestPair(client, target);
    }
    if (result.refused) return ['pairing requested'];
    recordPairing(data, workspace, result.status, target);
    return pairingLines(result);
  } catch {
    return ['pairing requested'];
  }
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

function missingHooks(data, cwd) {
  const entry = cloneEntry(data, cwd);
  if (!entry.initialized) return [];
  const have = installed(cwd);
  return (entry.hooks ?? []).filter((h) => !have.includes(h));
}

const warnMissing = (data, cwd, out) => {
  const missing = missingHooks(data, cwd);
  if (missing.length) out(`eocrm hooks missing from ${missing.join(', ')} (a hook manager rewrote them?): run eocrm init again`);
};

async function cliStatus({ cwd, out, data, env, store, harness, spawnFlush }) {
  const ctx = { data, env, store, harness, now: Date.now };
  const entry = repoEntry(data, cwd);
  if (!cloneEntry(data, cwd).initialized) out('not set up in this repository: run eocrm init');
  else {
    const hooks = installed(cwd);
    out(hooks.length ? `hooks ${hooks.join(', ')}` : 'hooks not installed: run eocrm init');
    warnMissing(data, cwd, out);
  }
  if (!launcherTarget(data)) out('the hooks\' copy of the CLI is missing or broken: run npx @eocrm/cli@latest init');
  out(entry.agent ? `agent ${entry.agent}` : 'no agent set');
  if (pluginLive(cwd, Date.now())) {
    out(LIVE);
    return;
  }
  const ended = await endStale(ctx, cwd);
  for (const r of ended) out(`run ${r.agent} ended: idle or on another branch`);
  const runs = liveRuns(data, cwd);
  for (const r of runs) {
    out(`run ${r.agent}${r.explicit ? ' (started)' : ''}${r.start?.task ? ` on ${r.start.task}` : ''}`);
    if (r.outdated) out(`this CLI is below the minimum ${plain(r.outdated.minimum ?? 'version')}: run npx @eocrm/cli@latest init`);
    const pr = await queuePr(ctx, cwd, r).catch(() => null);
    if (pr) out(`pull request #${pr.number} ${pr.action}`);
  }
  if (runs.length || ended.length) (spawnFlush ?? realSpawnFlush)(ctx);
}

const who = (account, workspace) => `Signed in at ${new URL(account.issuer).host} — reporting to ${workspace}`;

const commands = {
  async login({ values, positionals: [workspace], env, cwd, out, data, store, open, harness, sleep }) {
    if (values.device && harness !== 'cli') throw new Usage('--device is for the eocrm CLI (npx @eocrm/cli login --device)');
    const region = values.region ?? 'eu';
    const result = await login({ data, region, workspace, env, store, harness, device: values.device, sleep, print: out, openBrowser: (u) => open(u, { print: out }) });
    if (!result.workspace) {
      const flag = region === 'eu' ? '' : ` --region ${region}`;
      [`Signed in at ${new URL(result.issuer).host} (${region})`, ...result.choices, `choose one: eocrm init${flag} <workspace> in a repository, or eocrm login${flag} <workspace> for your default`].forEach((l) => out(l));
      return null;
    }
    const lines = [`${who(loadAccount(data), result.workspace)} (${region})`];
    if (result.storage === 'file') lines.push(`tokens stored in ${join(data, 'credentials.json')}: no keychain found`);
    lines.push(...pairingLines(result.pairing));
    const { pending } = resolveWorkspace({ data, cwd });
    if (pending) lines.push(committedLine(pending, harness));
    lines.forEach((l) => out(l));
  },

  async use({ values, positionals: [workspace], cwd, out, data, harness }) {
    if (values.accept || values.decline) {
      const file = answerCommitted({ data, cwd, accepted: Boolean(values.accept) });
      out(values.accept ? `this repository uses ${file.workspace} (.claude/eocrm.json)` : 'this repository keeps your default workspace');
      return;
    }
    if (!workspace) throw new Usage('workspace required');
    useWorkspace({ data, cwd, workspace, here: values.here });
    out(values.here ? `this worktree uses ${workspace}` : `this repository uses ${workspace}`);
    if (!(workspace in (loadAccount(data).workspaces ?? {}))) out(`run ${cmd(harness, 'login')} ${workspace}`);
  },

  async pair({ positionals: [id], env, cwd, out, data, store, harness }) {
    if (!id) throw new Usage('connection id required');
    const { workspace, region } = resolveWorkspace({ data, cwd });
    if (!workspace || !region) throw new Usage(`workspace required: run ${cmd(harness, 'login')} first`);
    const result = await requestPair(createClient({ endpoints: endpoints({ region, env }), workspace, store, harness }), id);
    recordPairing(data, workspace, result.status, id);
    pairingLines(result).forEach((l) => out(l));
    return result.status === 'standalone' ? 3 : 0;
  },

  async status({ env, cwd, out, data, store, harness, spawnFlush }) {
    const account = loadAccount(data);
    const { workspace, region, source, pending } = resolveWorkspace({ data, cwd });
    const tokens = account.region ? await store.get(endpoints({ region: account.region, env }).key, { timeoutMs: 2500 }) : null;
    out(tokens?.access_token ? `signed in (${account.region})` : `signed out: run ${cmd(harness, 'login')}`);
    if (harness === 'codex') {
      const ran = lastHookAt(data, worktreeOf(cwd).key);
      if (ran === null || ran < (account.signedInAt ?? 0)) out(TRUST);
    }
    if (harness === 'cli') await cliStatus({ cwd, out, data, env, store, harness, spawnFlush });
    if (!workspace) return;
    out(`workspace ${workspace} (${source})`);
    const known = account.workspaces?.[workspace];
    if (tokens?.access_token && account.issuer && region === account.region && known) out(who(account, workspace));
    if (region !== account.region) out(`run ${cmd(harness, 'login')} --region ${region} ${workspace}`);
    else if (!known) out(`run ${cmd(harness, 'login')} ${workspace}`);
    else if (known === 'requested') for (const l of await recheck({ data, env, store, workspace, region, harness })) out(l);
    else out(`pairing ${known}`);
    if (pending) out(committedLine(pending, harness));
  },

  async link({ values, positionals: [answer, change], env, cwd, out, data, spawnFlush, harness }) {
    if (change !== undefined) {
      if (!CHANGE_ID.test(answer) || (change !== 'none' && !LINK_KEY.test(change))) throw new Usage('usage: eocrm link <change> <KEY|none>');
      linkChange(data, cwd, answer, change === 'none' ? null : change);
      out(change === 'none' ? `${answer} not linked` : `${answer} linked to ${change}`);
      return;
    }
    if (answer !== 'none' && !LINK_KEY.test(answer ?? '')) throw new Usage('usage: eocrm link <KEY|none>');
    const taskKey = answer === 'none' ? null : answer;
    const { others, pending } = await linkWorktree({ data, env, now: Date.now, spawnFlush, harness }, cwd, taskKey, values.session);
    out(`${taskKey ? `linked to ${taskKey}` : 'not linked to a task'}${pending ? ` (applies when work moves to ${pending})` : ''}`);
    if (!values.session) out('Only the default for new sessions changed (no --session).');
    if (others.length) {
      const tasks = [...new Set(others.map((o) => o.task ?? 'none'))].sort().join(', ');
      out(`Also active here: ${others.length} other session${others.length === 1 ? '' : 's'} (on ${tasks}).`);
    }
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
    const queued = await enqueue(data, { kind: 'event', sessionId: run.sessionId, event: { id: eventId(type, key), type, occurred_at: new Date().toISOString(), ...fields, task_key: taskFor({ data }, { cwd, session_id: run.sessionId })(run) } });
    if (!queued) throw Object.assign(new Error(`${kind} not recorded: the local queue is unavailable`), { exitCode: 1 });
    out(`recorded ${kind}`);
  },

  async conventions({ values, env, cwd, out, data, store, harness }) {
    const run = liveRun(data, cwd, values.session);
    const conventions = await loadConventions({}, run, { conventions: () => runClient({ data, env, store, harness })(run).conventions() }, Date.now() + CONVENTIONS_MS, { refresh: values.refresh });
    if (!conventions) throw new Error('conventions unavailable: ask the member');
    if (conventions !== run.conventions) {
      await withLock(data, async () => {
        saveRun(data, run.sessionId, { conventions, conventionsAt: Date.now() });
      }, { giveUpMs: 1500 }).catch(() => {});
    }
    const compact = { workspace: run.workspace, ...conventions };
    delete compact.workflows;
    out(JSON.stringify(compact));
  },

  async init(ctx) {
    const { values, positionals: [workspace], env, cwd, out, data, store, harness } = ctx;
    if (harness !== 'cli') throw new Usage(CLI_ONLY('init'));
    if (values.agent !== undefined && values.agent !== 'none' && !AGENTS.includes(values.agent)) throw new Usage(`--agent must be ${[...AGENTS, 'none'].join('|')}`);
    const dir = hooksDir(cwd);
    const scope = hooksScope(cwd);
    if (scope?.shared && !values['shared-hooks']) throw new Usage(`core.hooksPath comes from your ${scope.scope} git config, so ${dir} is shared by other repositories: pass --shared-hooks to add eocrm there anyway`);
    if (scope?.shared) out(`core.hooksPath is shared (${scope.scope} config): eocrm's line goes into ${dir} for every repository using it, and stays quiet where eocrm init never ran`);
    const account = loadAccount(data);
    const tokens = account.region ? await store.get(endpoints({ region: account.region, env }).key, { timeoutMs: 2500 }) : null;
    const signedIn = tokens?.access_token && !(workspace && !(workspace in (account.workspaces ?? {})));
    if (!signedIn) await commands.login({ ...ctx, positionals: [workspace] });
    if (workspace) useWorkspace({ data, cwd, workspace });
    const target = resolveWorkspace({ data, cwd }).workspace;
    if (!target) throw new Usage('workspace required: eocrm init <workspace>');
    if (signedIn && account.issuer && target) out(who(account, target));
    const launcher = installCopy(data);
    const { done, skipped, lefthook } = install(cwd, { launcher, data });
    updateClone(data, cwd, { initialized: true, hooks: done });
    if (values.agent !== undefined) updateRepo(data, cwd, { agent: values.agent === 'none' ? null : values.agent });
    out(`git hooks in ${dir}: ${done.join(', ') || 'none'}`);
    if (lefthook) out(`lefthook: commands added to ${lefthook}`);
    for (const why of skipped) out(`skipped ${why}`);
    const agent = repoEntry(data, cwd).agent;
    out(agent ? `commits without an agent signal count as ${agent}` : `no agent set: only commits with an agent signal are tracked (eocrm init --agent ${AGENTS.join('|')})`);
  },

  async uninstall({ data, cwd, out, harness }) {
    if (harness !== 'cli') throw new Usage(CLI_ONLY('uninstall'));
    const { dir, removed } = uninstall(cwd);
    if (cloneEntry(data, cwd).initialized) updateClone(data, cwd, { initialized: false, hooks: [] });
    out(removed.length ? `removed eocrm from ${removed.join(', ')} in ${dir}` : 'no eocrm hooks here');
  },

  async hook({ positionals: [name, ...args], cwd, data, env, store, harness }) {
    if (harness !== 'cli') throw new Usage(CLI_ONLY('hook'));
    await runHook({ data, env, store, harness, now: Date.now }, name, cwd, args);
  },

  async sync({ values, cwd, out, data, env, store, harness }) {
    if (harness !== 'cli') throw new Usage(CLI_ONLY('sync'));
    const { quiet, runs, result } = await sync({ data, env, store, harness, now: Date.now }, cwd);
    if (values.quiet) return;
    warnMissing(data, cwd, out);
    if (quiet) out(LIVE);
    else if (!runs) out('no active run here: eocrm run start');
    else out(`sent ${result.sent}${result.retryable ? ', more queued' : ''}${result.signedOut ? ': signed out, run eocrm login' : ''}`);
  },

  async run({ values, positionals: [action], cwd, out, data, env, store, harness, spawnFlush }) {
    if (harness !== 'cli') throw new Usage(CLI_ONLY('run'));
    const ctx = { data, env, store, harness, now: Date.now, spawnFlush: spawnFlush ?? realSpawnFlush };
    if (action === 'stop') {
      const runs = await stopRuns(ctx, cwd);
      out(runs.length ? `stopped ${runs.map((r) => r.agent).join(', ')}` : 'no active run here');
      return;
    }
    if (action !== 'start') throw new Usage('usage: eocrm run start|stop [--agent <agent>]');
    if (values.agent !== undefined && !AGENTS.includes(values.agent)) throw new Usage(`--agent must be ${AGENTS.join('|')}`);
    if (pluginLive(cwd, Date.now())) throw Object.assign(new Error(LIVE), { exitCode: 3 });
    const agent = values.agent ?? agentFor(ctx, cwd);
    if (!agent) throw new Usage(`no agent: pass --agent ${AGENTS.join('|')}`);
    const run = await startRun(ctx, cwd, agent, { explicit: true });
    if (!run) throw new Usage(`no workspace: run ${cmd(harness, 'init')}`);
    ctx.spawnFlush(ctx);
    out(`run started for ${agent}`);
    warnMissing(data, cwd, out);
  },

  async openspec({ values, positionals: [action], cwd, out, data, env, store, harness }) {
    if (action !== 'import') throw new Usage('usage: eocrm openspec import [--space <KEY>]');
    const { workspace, region } = resolveWorkspace({ data, cwd });
    if (!workspace || !region) throw new Usage(`workspace required: run ${cmd(harness, 'init')}`);
    return importChanges({ client: createClient({ endpoints: endpoints({ region, env }), workspace, store, harness }), data, cwd, space: values.space, out });
  },

  async logout({ env, out, data, store, harness }) {
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
    if (failed.length) out(`sign-out incomplete, run ${cmd(harness, 'logout')} again`);
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
  script = fileURLToPath(import.meta.url),
  harness: forced,
  sleep,
} = {}) {
  if (!(Number(String(version).split('.')[0]) >= 20)) {
    err('eocrm needs Node 20+ on PATH');
    return 1;
  }
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    const [name, ...rest] = positionals;
    const command = Object.hasOwn(commands, name) ? commands[name] : null;
    if (!command) throw new Usage('usage: eocrm init|login|use|pair|status|link|record|conventions|sync|run|openspec|uninstall|logout|smoke-seed --data <dir>');
    const harness = forced ?? cliHarness({ flag: values.harness, env, script });
    if (harness === 'codex') values.session ||= env.CODEX_THREAD_ID;
    if (values.session && !/^[\w-]+$/.test(values.session)) throw new Usage('invalid --session');
    let data;
    try {
      // The CLI ignores plugin data env, so its sign-in never lands in a plugin's dir.
      data = harness === 'cli'
        ? dataDir({ argv: [], env: {}, data: values.data || cliData(env) })
        : dataDir({ argv, env, data: values.data, harness, fallback: harness === 'codex' ? installData(script) ?? codexData(env) : undefined });
    } catch (e) {
      throw new Usage(e.message);
    }
    const code = await command({ values, positionals: rest, env, cwd, out, data, harness, store: store ?? storeFor(data, harness), open, spawnFlush, gh, sleep });
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

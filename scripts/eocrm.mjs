import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataDir } from '../lib/paths.mjs';
import { endpoints } from '../lib/endpoints.mjs';
import { createClient } from '../lib/api.mjs';
import { credentialStore } from '../lib/credentials.mjs';
import { login, openBrowser, requestPair, recordPairing, plain } from '../lib/login.mjs';
import { accountFile, loadAccount, resolveWorkspace, useWorkspace, answerCommitted } from '../lib/workspace.mjs';
import { writeJsonAtomic } from '../lib/state.mjs';

const OPTIONS = { data: { type: 'string' }, region: { type: 'string' }, here: { type: 'boolean' }, accept: { type: 'boolean' }, decline: { type: 'boolean' } };
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

  async logout({ env, out, data, store }) {
    const account = loadAccount(data);
    const keys = new Set(Array.isArray(account.keys) ? account.keys : []);
    if (account.region) keys.add(endpoints({ region: account.region, env }).key);
    for (const key of keys) {
      try {
        await store.del(key);
        out(`signed out of ${plain(String(key).split(' ')[0])}`);
      } catch {
        // a malformed key in account.json names nothing stored
      }
    }
    writeJsonAtomic(accountFile(data), { ...account, keys: [] });
    if (!keys.size) out('signed out');
  },
};

function committedLine({ workspace, region }) {
  return `.claude/eocrm.json names ${workspace} (${region}): ask the member, then run /eocrm:use --accept or /eocrm:use --decline`;
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  out = (l) => process.stdout.write(`${l}\n`),
  err = (l) => process.stderr.write(`${l}\n`),
  version = process.versions.node,
  store,
  openBrowser: open = openBrowser,
} = {}) {
  if (!(Number(String(version).split('.')[0]) >= 20)) {
    err('eocrm needs Node 20+ on PATH');
    return 1;
  }
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    const [name, ...rest] = positionals;
    const command = Object.hasOwn(commands, name) ? commands[name] : null;
    if (!command) throw new Usage('usage: eocrm login|use|pair|status|logout --data <dir>');
    let data;
    try {
      data = dataDir({ argv, env });
    } catch (e) {
      throw new Usage(e.message);
    }
    const code = await command({ values, positionals: rest, env, cwd, out, data, store: store ?? credentialStore({ data }), open });
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

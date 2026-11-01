import { realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { SLUG, REGIONS } from './endpoints.mjs';
import { readJson, writeJsonAtomic, worktreeOf, loadWorktree, saveWorktree, git } from './state.mjs';

export const accountFile = (data) => join(data, 'account.json');
export const loadAccount = (data) => readJson(accountFile(data), {});
const reposFile = (data) => join(data, 'repos.json');
const isSlug = (s) => typeof s === 'string' && SLUG.test(s);

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCP = /^[^/\\]{2,}:/;

export function normaliseRemote(url) {
  const t = url.trim();
  const scheme = SCHEME.exec(t);
  const rest = t.slice(scheme ? scheme[0].length : 0).replace(/^[^/]*@/, '');
  return (scheme ? rest.replace(/^([^/:]+):\d*\//, '$1/') : rest.replace(/^([^/:]+):/, '$1/'))
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

export function repoKey(cwd) {
  const origin = git(cwd, ['remote', 'get-url', 'origin']);
  if (origin && (SCHEME.test(origin) || SCP.test(origin) || isAbsolute(origin))) return normaliseRemote(origin);
  const common = git(cwd, ['rev-parse', '--git-common-dir']);
  if (!common) return null;
  let dir = resolve(cwd, common);
  try {
    dir = realpathSync.native(dir);
  } catch {
    // keep as resolved
  }
  return process.platform === 'win32' ? dir.toLowerCase() : dir;
}

// Only a slug and a known region are taken from a repo's file: it is not trusted to name hosts.
function committedFile(root) {
  const f = readJson(join(root, '.claude', 'eocrm.json'), null);
  return f && isSlug(f.workspace) && REGIONS.includes(f.region) ? { workspace: f.workspace, region: f.region } : null;
}

export function resolveWorkspace({ data, cwd }) {
  const wt = worktreeOf(cwd);
  const account = loadAccount(data);
  const key = repoKey(cwd);
  const entry = (key && readJson(reposFile(data), {})[key]) || {};
  const pick = (workspace, source, region = account.region ?? null, pending = null) => ({ workspace, region, source, pending });

  const override = loadWorktree(data, wt.key).workspace;
  if (isSlug(override)) return pick(override, 'worktree');
  if (isSlug(entry.workspace)) return pick(entry.workspace, 'repo');
  const file = committedFile(wt.root);
  const answer = file && entry.committed?.workspace === file.workspace && entry.committed.region === file.region ? entry.committed.accepted : undefined;
  if (answer === true) return pick(file.workspace, 'committed', file.region);
  const differs = file && (file.workspace !== account.workspace || file.region !== account.region);
  return pick(isSlug(account.workspace) ? account.workspace : null, 'default', undefined, differs && answer === undefined ? file : null);
}

function updateRepo(data, cwd, patch) {
  const key = repoKey(cwd);
  if (!key) throw Object.assign(new Error('not a git repository: use --here'), { exitCode: 2 });
  const repos = readJson(reposFile(data), {});
  repos[key] = { ...repos[key], ...patch };
  writeJsonAtomic(reposFile(data), repos);
}

export function useWorkspace({ data, cwd, workspace, here = false }) {
  if (!isSlug(workspace)) throw Object.assign(new Error('invalid workspace slug'), { exitCode: 2 });
  if (here) saveWorktree(data, worktreeOf(cwd).key, { workspace });
  else updateRepo(data, cwd, { workspace });
}

export function answerCommitted({ data, cwd, accepted }) {
  const file = committedFile(worktreeOf(cwd).root);
  if (!file) throw Object.assign(new Error('no valid .claude/eocrm.json in this repository'), { exitCode: 2 });
  updateRepo(data, cwd, { committed: { ...file, accepted } });
  return file;
}

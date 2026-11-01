import { execFileSync } from 'node:child_process';
import { git } from './state.mjs';
import { clean } from './scrub.mjs';

const BASES = ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master'];

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const FORGE = /^(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org)$/i;
const UNSAFE = /[@:?#]/;

export function repoSlug(cwd, origin = git(cwd, ['remote', 'get-url', 'origin'])) {
  const url = origin.trim();
  let host;
  let path;
  if (SCHEME.test(url)) {
    try {
      ({ hostname: host, pathname: path } = new URL(url));
    } catch {
      return null;
    }
  } else {
    const colon = url.indexOf(':');
    if (colon < 0) return null;
    const auth = url.slice(0, colon);
    host = auth.slice(auth.lastIndexOf('@') + 1);
    path = url.slice(colon + 1);
    if (host.length < 2 || /[\\/]/.test(host)) return null;
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!host || !path || UNSAFE.test(host + path)) return null;
  return clean(FORGE.test(host) ? path : `${host}/${path}`, 200);
}

export function budget(ms, { exec = execFileSync, now = Date.now } = {}) {
  const end = now() + ms;
  return (cmd, args, opts) => {
    const left = end - now();
    if (left <= 0) throw new Error('eocrm: hook budget spent');
    return exec(cmd, args, { ...opts, timeout: Math.min(opts.timeout || left, left) });
  };
}

export function mergeBase(cwd, run) {
  const have = new Set(git(cwd, ['for-each-ref', '--format=%(refname)', ...BASES], run).split('\n'));
  const ref = BASES.find((r) => have.has(r));
  return (ref && git(cwd, ['merge-base', 'HEAD', ref], run)) || null;
}

export function branchCommits(cwd, limit = 200, run) {
  const base = mergeBase(cwd, run);
  if (!base) return [];
  const log = git(cwd, ['log', '-z', `-n${limit}`, '--format=%H%x1f%s', `${base}..HEAD`], run);
  return log.split('\0').filter(Boolean).map((line) => {
    const [sha, subject = ''] = line.split('\x1f');
    return { sha: sha.trim(), subject };
  }).reverse();
}

export function localBranches(cwd, run) {
  const out = git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], run);
  return out ? out.split('\n') : null;
}

export function prView(cwd, arg, run = execFileSync) {
  try {
    const args = ['pr', 'view', ...(arg ? [arg] : []), '--json', 'url', '-q', '.url'];
    return String(run('gh', args, { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })).trim() || null;
  } catch {
    return null;
  }
}

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

export function defaultBranch(cwd, run) {
  const remote = git(cwd, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], run);
  if (remote) return remote.replace(/^origin\//, '');
  const have = git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/main', 'refs/heads/master'], run).split('\n');
  return ['main', 'master'].find((b) => have.includes(b)) ?? null;
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

const SHA = /^[0-9a-f]{40,64}$/;
// HEAD moves the session's own git command makes; pulls, merges, resets, rebases and checkouts are never its own.
const OWN_MOVE = /^(?:commit|cherry-pick|revert)\b/;
const REFLOG_SPAN = 50;

export function reached(cwd, shas, run) {
  const own = Array.isArray(shas) ? shas.filter((s) => SHA.test(s)) : [];
  if (!own.length) return [];
  const away = new Set(git(cwd, ['rev-list', '--ignore-missing', ...own, '--not', 'HEAD'], run).split('\n'));
  return own.filter((s) => !away.has(s));
}

// Commits HEAD's reflog shows made since `since`, the HEAD the session last saw ('' in an empty repo); still on HEAD, oldest first.
export function sessionCommits(cwd, since, run) {
  const found = [];
  let seen = since === '';
  for (const entry of git(cwd, ['log', '-g', '-z', `-n${REFLOG_SPAN}`, '--format=%H%x1f%gs%x1f%s', 'HEAD'], run).split('\0').filter(Boolean)) {
    const [sha, move = '', ...subject] = entry.split('\x1f');
    if (sha === since) {
      seen = true;
      break;
    }
    if (OWN_MOVE.test(move) && !found.some((c) => c.sha === sha)) found.push({ sha, subject: subject.join('\x1f') });
  }
  // ponytail: a last-seen HEAD older than REFLOG_SPAN moves claims nothing; walk further if sessions ever outrun it.
  if (!seen) return [];
  const on = new Set(reached(cwd, found.map((c) => c.sha), run));
  return found.filter((c) => on.has(c.sha)).reverse();
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

// undefined: gh is not installed, so the caller stops asking.
export function prState(cwd, url, run = execFileSync) {
  try {
    return String(run('gh', ['pr', 'view', url, '--json', 'state', '-q', '.state'], { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })).trim() || null;
  } catch (e) {
    return e?.code === 'ENOENT' ? undefined : null;
  }
}

const PULL = /^https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+$/;
const PR_ACTIONS = { OPEN: 'opened', MERGED: 'merged' };

// The current branch's PR, via an installed and signed-in gh; a closed PR has no eocrm action.
export function prStatus(cwd, run = execFileSync) {
  try {
    const o = JSON.parse(String(run('gh', ['pr', 'view', '--json', 'url,state,number'], { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })));
    const action = PR_ACTIONS[o?.state];
    return action && PULL.test(o.url) && Number.isInteger(o.number) ? { action, url: o.url, number: o.number } : null;
  } catch {
    return null;
  }
}

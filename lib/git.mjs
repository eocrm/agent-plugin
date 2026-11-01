import { execFileSync } from 'node:child_process';
import { git } from './state.mjs';
import { clean } from './scrub.mjs';

const BASES = ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'];

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

export function branchCommits(cwd, limit = 200) {
  for (const ref of BASES) {
    const base = git(cwd, ['merge-base', 'HEAD', ref]);
    if (!base) continue;
    const log = git(cwd, ['log', '-z', `-n${limit}`, '--format=%H%x1f%s', `${base}..HEAD`]);
    return log.split('\0').filter(Boolean).map((line) => {
      const [sha, subject = ''] = line.split('\x1f');
      return { sha: sha.trim(), subject };
    }).reverse();
  }
  return [];
}

export function prView(cwd, arg, run = execFileSync) {
  try {
    const args = ['pr', 'view', ...(arg ? [arg] : []), '--json', 'url', '-q', '.url'];
    return String(run('gh', args, { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })).trim() || null;
  } catch {
    return null;
  }
}

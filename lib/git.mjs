import { execFileSync } from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
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

// The default branch has no range of its own: there only commits the session made count (madeDuring).
export function branchCommits(cwd, limit = 200, run) {
  const base = mergeBase(cwd, run);
  if (!base) return [];
  const branch = git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], run);
  if (branch && branch === defaultBranch(cwd, run)) return [];
  const log = git(cwd, ['log', '-z', `-n${limit}`, '--format=%H%x1f%s', `${base}..HEAD`], run);
  return log.split('\0').filter(Boolean).map((line) => {
    const [sha, subject = ''] = line.split('\x1f');
    return { sha: sha.trim(), subject };
  }).reverse();
}

const SHA = /^[0-9a-f]{40,64}$/;
const OWN_MOVE = /^(?:commit|cherry-pick|revert)\b/;
const PICK = /^(?:pull|rebase)\b[^(:]*\((?:pick|reword|edit|continue)\):/;
const WINDOW_MAX = 256 * 1024;

export function reached(cwd, shas, run) {
  const own = Array.isArray(shas) ? shas.filter((s) => SHA.test(s)) : [];
  if (!own.length) return [];
  const away = new Set(git(cwd, ['rev-list', '--ignore-missing', ...own, '--not', 'HEAD'], run).split('\n'));
  return own.filter((s) => !away.has(s));
}

const headLog = (gitDir) => join(gitDir, 'logs', 'HEAD');

// HEAD's reflog length before a tool call; 0 when it has none yet (unborn HEAD, no reflog); null when unreadable.
export function reflogMark(gitDir) {
  try {
    return statSync(headLog(gitDir)).size;
  } catch (e) {
    return e?.code === 'ENOENT' ? 0 : null;
  }
}

// Commits the reflog shows made since a mark, still on HEAD (a rebased-away one as its rebased pick), oldest first.
// Accepted: another writer's commit inside the window counts; no reflog claims nothing; a merge is never claimed;
// an interrupted call (no PostToolUse) or a reflog truncated during the call loses its commits.
export function madeDuring(cwd, gitDir, from, run) {
  let text;
  try {
    const fd = openSync(headLog(gitDir), 'r');
    try {
      const end = Math.min(fstatSync(fd).size, from + WINDOW_MAX);
      if (end <= from) return [];
      const buf = Buffer.alloc(end - from + 1);
      const n = readSync(fd, buf, 0, buf.length, from - (from > 0 ? 1 : 0));
      text = buf.subarray(0, n).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  if (from > 0) {
    if (text[0] !== '\n') return [];
    text = text.slice(1);
  }
  const entries = text.split('\n').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    return { sha: line.split(' ')[1], move: tab < 0 ? '' : line.slice(tab + 1) };
  }).filter((e) => SHA.test(e.sha ?? ''));
  const claimed = [...new Set(entries.filter((e) => OWN_MOVE.test(e.move)).map((e) => e.sha))];
  if (!claimed.length) return [];
  const others = [...new Set(entries.filter((e) => PICK.test(e.move)).map((e) => e.sha))].filter((s) => !claimed.includes(s));
  const on = new Set(reached(cwd, [...claimed, ...others], run));
  const info = new Map(git(cwd, ['log', '-z', '--no-walk=unsorted', '--format=%H%x1f%an <%ae> %at%x1f%s', ...claimed, ...others], run).split('\0').filter(Boolean).map((l) => {
    const [sha, author, ...subject] = l.split('\x1f');
    return [sha.trim(), { author, subject: subject.join('\x1f') }];
  }));
  // A rebase pick in the same call keeps author, date and subject.
  const key = (s) => info.has(s) && `${info.get(s).author}\x1f${info.get(s).subject}`;
  const out = [];
  for (const sha of claimed) {
    const now = on.has(sha) ? sha : others.find((o) => on.has(o) && key(o) && key(o) === key(sha));
    if (now && info.has(now) && !out.some((c) => c.sha === now)) out.push({ sha: now, subject: info.get(now).subject });
  }
  return out;
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

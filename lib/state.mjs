import { mkdirSync, rmSync, renameSync, statSync, readFileSync, writeFileSync, realpathSync, openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const POLL_MS = 25;
const STALE_MS = 30000;
const GIVE_UP_MS = 5000;

export class LockTimeout extends Error {
  constructor(dir) {
    super(`eocrm: lock timeout in ${dir}`);
    this.name = 'LockTimeout';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const owner = (lock) => {
  try {
    return readFileSync(join(lock, 'owner'), 'utf8');
  } catch {
    return null;
  }
};

export const remove = (path) => {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // a leftover lock goes stale; never mask fn's outcome
  }
};

export function breakStale(lock, seen) {
  const grave = `${lock}.${process.pid}.${randomBytes(4).toString('hex')}`;
  renameSync(lock, grave);
  if (owner(grave) === seen && Date.now() - statSync(grave).mtimeMs > STALE_MS) {
    remove(grave);
    return true;
  }
  try {
    renameSync(grave, lock);
  } catch {
    remove(grave);
  }
  return false;
}

// ponytail: lock mtime is never refreshed, so an fn longer than STALE_MS can be broken; fine for short hooks, add a heartbeat if not.
export async function withLock(dir, fn, { giveUpMs = GIVE_UP_MS } = {}) {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, '.lock');
  const token = randomBytes(16).toString('hex');
  const deadline = Date.now() + giveUpMs;
  for (;;) {
    try {
      mkdirSync(lock);
    } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      try {
        const seen = owner(lock);
        if (Date.now() - statSync(lock).mtimeMs > STALE_MS && breakStale(lock, seen)) continue;
      } catch {
        // lock vanished or unreadable: just retry
      }
      if (Date.now() >= deadline) throw new LockTimeout(dir);
      await sleep(POLL_MS);
      continue;
    }
    try {
      writeFileSync(join(lock, 'owner'), token);
      break;
    } catch (e) {
      remove(lock);
      throw e;
    }
  }
  try {
    return await fn();
  } finally {
    if (owner(lock) === token) remove(lock);
  }
}

export function readJson(file, fallback) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const RETRY = new Set(['EPERM', 'EBUSY', 'EACCES']);

export function writeJsonAtomic(file, value, { mode = 0o666 } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const json = JSON.stringify(value);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', mode);
  try {
    try {
      writeFileSync(fd, json);
    } finally {
      closeSync(fd);
    }
    for (let i = 0; ; i++) {
      try {
        renameSync(tmp, file);
        return;
      } catch (e) {
        if (process.platform !== 'win32' || !RETRY.has(e.code) || i >= 3) throw e;
        nap(20 * (i + 1));
      }
    }
  } catch (e) {
    remove(tmp);
    throw e;
  }
}

export function worktreeOf(cwd) {
  let root = cwd;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || cwd;
  } catch {
    // not a git checkout
  }
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    // path vanished: hash as given
  }
  if (process.platform === 'win32') real = real.toLowerCase();
  return { root, key: createHash('sha256').update(real).digest('hex').slice(0, 16) };
}

const worktreeFile = (data, key) => join(data, 'worktrees', `${key}.json`);
const runFile = (data, sessionId) => {
  if (typeof sessionId !== 'string' || !/^[\w-]+$/.test(sessionId)) throw new Error('eocrm: invalid session id');
  return join(data, 'runs', `${sessionId}.json`);
};

export function loadWorktree(data, key) {
  return { root: '', taskKey: null, linkAnswered: false, reportedCommits: [], openPrs: [], ...readJson(worktreeFile(data, key), {}) };
}

export function saveWorktree(data, key, patch) {
  const next = { ...loadWorktree(data, key), ...patch };
  writeJsonAtomic(worktreeFile(data, key), next);
  return next;
}

export function loadRun(data, sessionId) {
  return { sessionId, acked: {}, rejected: [], blockedFingerprints: [], serverEventsRead: false, ...readJson(runFile(data, sessionId), {}) };
}

export function saveRun(data, sessionId, patch) {
  const next = { ...loadRun(data, sessionId), ...patch };
  writeJsonAtomic(runFile(data, sessionId), next);
  return next;
}

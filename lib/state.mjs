import { mkdirSync, rmSync, renameSync, statSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
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

export async function withLock(dir, fn) {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, '.lock');
  const deadline = Date.now() + GIVE_UP_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_MS) {
          const grave = `${lock}.${process.pid}.${randomBytes(4).toString('hex')}`;
          renameSync(lock, grave);
          rmSync(grave, { recursive: true, force: true });
          continue;
        }
      } catch {
        // lock vanished or unreadable: just retry
      }
      if (Date.now() >= deadline) throw new LockTimeout(dir);
      await sleep(POLL_MS);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      if (process.platform === 'win32' && e.code === 'EPERM' && i < 3) {
        nap(20 * (i + 1));
        continue;
      }
      rmSync(tmp, { force: true });
      throw e;
    }
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
const runFile = (data, sessionId) => join(data, 'runs', `${sessionId}.json`);

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

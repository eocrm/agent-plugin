import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, utimesSync, symlinkSync, realpathSync, readFileSync, writeFileSync, existsSync, readdirSync, chmodSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLock, breakStale, readJson, writeJsonAtomic, worktreeOf, loadWorktree, saveWorktree, loadRun, saveRun, LockTimeout } from '../../lib/state.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'eocrm-state-'));

test('20 parallel withLock increments end at 20', async () => {
  const dir = tmp();
  const file = join(dir, 'n.json');
  writeJsonAtomic(file, { n: 0 });
  await Promise.all(Array.from({ length: 20 }, () => withLock(dir, async () => {
    const { n } = readJson(file, { n: 0 });
    await new Promise((r) => setTimeout(r, 2));
    writeJsonAtomic(file, { n: n + 1 });
  })));
  assert.equal(readJson(file).n, 20);
  assert.equal(existsSync(join(dir, '.lock')), false);
});

test('a 31-second-old lock is broken', async () => {
  const dir = tmp();
  mkdirSync(join(dir, '.lock'));
  const old = new Date(Date.now() - 31000);
  utimesSync(join(dir, '.lock'), old, old);
  assert.equal(await withLock(dir, async () => 'ok'), 'ok');
});

test('a fresh held lock times out with LockTimeout', async () => {
  const dir = tmp();
  mkdirSync(join(dir, '.lock'));
  await assert.rejects(withLock(dir, async () => 1), LockTimeout);
});

test('lock is released when fn throws', async () => {
  const dir = tmp();
  await assert.rejects(withLock(dir, async () => { throw new Error('x'); }), /x/);
  assert.equal(existsSync(join(dir, '.lock')), false);
});

test('readJson falls back on missing or corrupt file', () => {
  const dir = tmp();
  assert.deepEqual(readJson(join(dir, 'a.json'), { z: 1 }), { z: 1 });
  writeFileSync(join(dir, 'b.json'), '{bad');
  assert.deepEqual(readJson(join(dir, 'b.json'), []), []);
});

test('readJson falls back on JSON that is not a plain object', () => {
  const dir = tmp();
  for (const body of ['null', '"s"', '[1]', '5', 'true']) {
    writeFileSync(join(dir, 'c.json'), body);
    assert.deepEqual(readJson(join(dir, 'c.json'), { z: 1 }), { z: 1 }, body);
  }
});

test('loadRun survives a corrupt or wrong-shape run file', () => {
  const data = tmp();
  mkdirSync(join(data, 'runs'));
  for (const body of ['{bad', 'null', '[]']) {
    writeFileSync(join(data, 'runs', 's1.json'), body);
    assert.deepEqual(loadRun(data, 's1').acked, {}, body);
  }
});

test('session ids that could leave the runs dir are refused', () => {
  const data = tmp();
  for (const id of ['../x', 'a/b', 'a\\b', '..', '', 'a.b', null]) {
    assert.throws(() => loadRun(data, id), /invalid session id/, String(id));
    assert.throws(() => saveRun(data, id, {}), /invalid session id/, String(id));
  }
  assert.equal(loadRun(data, '0b5f-UUID_like').sessionId, '0b5f-UUID_like');
});

test('writeJsonAtomic leaves no temp files', () => {
  const dir = tmp();
  writeJsonAtomic(join(dir, 'sub', 'a.json'), { a: 1 });
  writeJsonAtomic(join(dir, 'sub', 'a.json'), { a: 2 });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'sub', 'a.json'), 'utf8')), { a: 2 });
  assert.deepEqual(readdirSync(join(dir, 'sub')), ['a.json']);
});

test('writeJsonAtomic removes its temp file when the rename fails', () => {
  const dir = tmp();
  mkdirSync(join(dir, 'a.json', 'x'), { recursive: true });
  assert.throws(() => writeJsonAtomic(join(dir, 'a.json'), { a: 1 }));
  assert.deepEqual(readdirSync(dir), ['a.json']);
});

test('writeJsonAtomic creates the file with the given mode', { skip: process.platform === 'win32' }, () => {
  const dir = tmp();
  writeJsonAtomic(join(dir, 'p.json'), { a: 1 }, { mode: 0o600 });
  assert.equal(statSync(join(dir, 'p.json')).mode & 0o777, 0o600);
  writeJsonAtomic(join(dir, 'q.json'), { a: 1 });
  assert.equal(statSync(join(dir, 'q.json')).mode & 0o777, 0o666 & ~process.umask());
});

test('breakStale puts back a lock that changed owner after it was judged stale', () => {
  const lock = join(tmp(), '.lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner'), 'B');
  const old = new Date(Date.now() - 31000);
  utimesSync(lock, old, old);
  assert.equal(breakStale(lock, 'A'), false);
  assert.equal(readFileSync(join(lock, 'owner'), 'utf8'), 'B');
});

test('breakStale puts back a lock that turned out fresh', () => {
  const lock = join(tmp(), '.lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner'), 'A');
  assert.equal(breakStale(lock, 'A'), false);
  assert.equal(readFileSync(join(lock, 'owner'), 'utf8'), 'A');
});

test('breakStale removes a stale lock it judged correctly', () => {
  const dir = tmp();
  const lock = join(dir, '.lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner'), 'A');
  const old = new Date(Date.now() - 31000);
  utimesSync(lock, old, old);
  assert.equal(breakStale(lock, 'A'), true);
  assert.deepEqual(readdirSync(dir), []);
});

test('release leaves a lock that another holder now owns', async () => {
  const dir = tmp();
  await withLock(dir, async () => writeFileSync(join(dir, '.lock', 'owner'), 'other'));
  assert.equal(readFileSync(join(dir, '.lock', 'owner'), 'utf8'), 'other');
});

const unwritable = process.platform === 'win32' || process.getuid?.() === 0;

test('a release that cannot remove the lock does not mask fn', { skip: unwritable }, async () => {
  const [a, b] = [tmp(), tmp()];
  try {
    assert.equal(await withLock(a, async () => { chmodSync(a, 0o500); return 'ok'; }), 'ok');
    await assert.rejects(withLock(b, async () => { chmodSync(b, 0o500); throw new Error('mine'); }), /mine/);
    assert.ok(existsSync(join(a, '.lock')));
  } finally {
    chmodSync(a, 0o700);
    chmodSync(b, 0o700);
  }
});

test('worktreeOf gives one key for two spellings of a path', () => {
  const real = tmp();
  const link = join(tmp(), 'link');
  symlinkSync(real, link);
  const a = worktreeOf(real);
  const b = worktreeOf(link);
  assert.equal(a.key, b.key);
  assert.match(a.key, /^[0-9a-f]{16}$/);
});

test('worktreeOf uses the git toplevel', () => {
  const dir = tmp();
  const sub = join(dir, 'a', 'b');
  mkdirSync(sub, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  assert.equal(realpathSync.native(worktreeOf(sub).root), realpathSync.native(dir));
  assert.equal(worktreeOf(sub).key, worktreeOf(dir).key);
});

test('saveWorktree and saveRun merge patches', () => {
  const data = tmp();
  assert.deepEqual(loadWorktree(data, 'k'), { root: '', taskKey: null, linkAnswered: false, reportedCommits: [], openPrs: [] });
  saveWorktree(data, 'k', { root: '/r', taskKey: 'AB-1' });
  saveWorktree(data, 'k', { linkAnswered: true });
  assert.deepEqual(loadWorktree(data, 'k'), { root: '/r', taskKey: 'AB-1', linkAnswered: true, reportedCommits: [], openPrs: [] });
  saveRun(data, 's1', { generation: 0, workspace: 'w' });
  saveRun(data, 's1', { runId: 'r1' });
  const run = loadRun(data, 's1');
  assert.equal(run.sessionId, 's1');
  assert.equal(run.generation, 0);
  assert.equal(run.workspace, 'w');
  assert.equal(run.runId, 'r1');
  assert.deepEqual(run.acked, {});
  assert.deepEqual(run.rejected, []);
  assert.equal(run.serverEventsRead, false);
});

test('withLock gives up after giveUpMs', async () => {
  const dir = tmp();
  mkdirSync(join(dir, '.lock'));
  const t = Date.now();
  await assert.rejects(withLock(dir, async () => 1, { giveUpMs: 100 }), LockTimeout);
  assert.ok(Date.now() - t < 2000);
});

test('a hung git times out and yields an empty answer instead of throwing', async () => {
  const { git } = await import('../../lib/state.mjs');
  let opts;
  const hung = (cmd, args, o) => {
    opts = o;
    throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
  };
  assert.equal(git('.', ['status'], hung), '');
  assert.equal(opts.timeout, 5000);
});

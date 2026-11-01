import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, utimesSync, symlinkSync, realpathSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLock, readJson, writeJsonAtomic, worktreeOf, loadWorktree, saveWorktree, loadRun, saveRun, LockTimeout } from '../../lib/state.mjs';

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

test('writeJsonAtomic leaves no temp files', () => {
  const dir = tmp();
  writeJsonAtomic(join(dir, 'sub', 'a.json'), { a: 1 });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'sub', 'a.json'), 'utf8')), { a: 1 });
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
  assert.equal(realpathSync(worktreeOf(sub).root), realpathSync(dir));
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { branchCommits, prView } from '../../lib/git.mjs';

const tmp = () => realpathSync.native(mkdtempSync(join(tmpdir(), 'eocrm-git-')));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
const commit = (cwd, m) => git(cwd, 'commit', '-q', '--allow-empty', '-m', m);

test('branchCommits lists the branch past its merge-base with main, oldest first', () => {
  const dir = tmp();
  git(dir, 'init', '-q', '-b', 'main');
  commit(dir, 'init');
  git(dir, 'checkout', '-q', '-b', 'feat');
  commit(dir, 'one');
  commit(dir, 'two');
  const got = branchCommits(dir);
  assert.deepEqual(got.map((c) => c.subject), ['one', 'two']);
  assert.equal(got[1].sha, git(dir, 'rev-parse', 'HEAD'));
  assert.deepEqual(branchCommits(dir, 1).map((c) => c.subject), ['two']);
});

test('branchCommits prefers origin/HEAD over a local main that moved', () => {
  const up = tmp();
  git(up, 'init', '-q', '-b', 'main');
  commit(up, 'init');
  const dir = join(tmp(), 'clone');
  git(up, 'clone', '-q', up, dir);
  git(dir, 'checkout', '-q', '-b', 'feat');
  commit(dir, 'mine');
  git(dir, 'branch', '-q', '-f', 'main', 'HEAD');
  assert.deepEqual(branchCommits(dir).map((c) => c.subject), ['mine']);
});

test('branchCommits is empty with no base or outside a repo', () => {
  const dir = tmp();
  git(dir, 'init', '-q', '-b', 'trunk');
  commit(dir, 'init');
  assert.deepEqual(branchCommits(dir), []);
  assert.deepEqual(branchCommits(tmp()), []);
});

test('prView asks gh for the url with a 5 s timeout and windowsHide, and survives gh missing', () => {
  let seen;
  const run = (cmd, args, opts) => {
    seen = { cmd, args, timeout: opts.timeout, windowsHide: opts.windowsHide, cwd: opts.cwd };
    return 'https://github.com/o/r/pull/7\n';
  };
  assert.equal(prView('/w', '7', run), 'https://github.com/o/r/pull/7');
  assert.deepEqual(seen, { cmd: 'gh', args: ['pr', 'view', '7', '--json', 'url', '-q', '.url'], timeout: 5000, windowsHide: true, cwd: '/w' });
  prView('/w', null, run);
  assert.deepEqual(seen.args, ['pr', 'view', '--json', 'url', '-q', '.url']);
  const missing = () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); };
  assert.equal(prView('/w', null, missing), null);
});

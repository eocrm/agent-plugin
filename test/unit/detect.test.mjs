import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { budget } from '../../lib/git.mjs';
import { testRun, prEvent, isCommit, sddStep, ledgerPresent, segments } from '../../lib/detect.mjs';
import { handle } from '../../lib/run.mjs';
import { readOutbox, writeOutbox } from '../../lib/outbox.mjs';
import { loadRun, saveRun, loadWorktree, worktreeOf } from '../../lib/state.mjs';
import { eventId } from '../../lib/ids.mjs';

const UNREACHABLE = JSON.stringify({ issuer: 'http://127.0.0.1:9', api: 'http://127.0.0.1:9/{workspace}/api' });
const tmp = (p) => realpathSync.native(mkdtempSync(join(tmpdir(), `eocrm-${p}-`)));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
const SECRET = 'ghp_FAKEfakeFAKEfakeFAKEfakeFAKEfake0000';

const bash = (command, stdout = '', extra = {}) => ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '', interrupted: false, isImage: false }, tool_use_id: 'toolu_1', ...extra });
const failed = (command, error) => ({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_2', error, is_interrupt: false });

const marked = (command, stdout = '', description = 'test: Unit tests', extra = {}) => bash(command, stdout, { tool_input: { command, description }, ...extra });

test('a test: description marks a run; label is the description without the prefix', () => {
  const out = ' RUN  v3\n\n ✓ a.test.js (3)\n\n Tests  3 passed (3)\n   Start at  10:00:00\n Duration  1.2s\n';
  assert.deepEqual(testRun(marked('npm test', out, 'test:  Backend tests for EO-92 ')), { command: 'npm test', label: 'Backend tests for EO-92', result_line: 'Tests  3 passed (3)', exit_code: 0 });
  assert.equal(testRun(marked('./check.sh', 'ok', 'test: x')).label, 'x');
});

test('unmarked commands are never test runs, whatever they run', () => {
  for (const c of ['make test', 'make test-down', 'npm test', 'pytest']) {
    assert.equal(testRun(bash(c, 'ok')), null, c);
    assert.equal(testRun(marked(c, 'ok', 'Run the tests')), null, c);
    assert.equal(testRun(marked(c, 'ok', 'run test: now')), null, c);
    assert.equal(testRun(marked(c, 'ok', null)), null, c);
    assert.equal(testRun(marked(c, 'ok', 'test:')), null, c);
  }
});

test('a failure parses its exit code and reads output after the Exit code line', () => {
  const fail = (command, error) => ({ ...failed(command, error), tool_input: { command, description: 'test: t' } });
  assert.deepEqual(testRun(fail('make test', 'Exit code 1\nFAIL x\n2 failed, 5 passed\n')), { command: 'make test', label: 't', result_line: '2 failed, 5 passed', exit_code: 1 });
  assert.equal(testRun(fail('pytest', 'Exit code 2\n')).exit_code, 2);
  assert.equal(testRun(fail('pytest', 'Command timed out after 2m')), null);
  assert.equal(testRun({ ...fail('pytest', 'Exit code 1\n'), is_interrupt: true }), null);
});

test('result_line is the last summary-shaped line, null when none matches; ANSI colour and CRLF are stripped', () => {
  assert.equal(testRun(marked('make test', 'building\r\ndone\r\n\r\n')).result_line, null);
  assert.equal(testRun(marked('make test', '')).result_line, null);
  assert.equal(testRun(marked('x', '\x1b[32m 4 passed\x1b[39m\nbye\n')).result_line, '4 passed');
  assert.equal(testRun(marked('x', '', undefined, { tool_response: { stdout: '', stderr: 'Tests: 1 failed\n' } })).result_line, 'Tests: 1 failed');
});

test('background, interrupted and non-Bash calls are not test runs', () => {
  assert.equal(testRun(marked('npm test', 'ok', undefined, { tool_input: { command: 'npm test', description: 'test: t', run_in_background: true } })), null);
  assert.equal(testRun(marked('npm test', 'ok', undefined, { tool_response: { stdout: 'ok', interrupted: true } })), null);
  assert.equal(testRun({ ...marked('npm test', 'ok'), tool_name: 'Write' }), null);
});

test('test command, label and result line are scrubbed and capped', () => {
  const got = testRun(marked(`TOKEN=${SECRET} npm test ${'x'.repeat(600)}`, `1 passed ${SECRET}\n`, `test: ${SECRET} ${'z'.repeat(600)}`));
  assert.doesNotMatch(JSON.stringify(got), /ghp_/);
  assert.ok(got.command.length <= 500 && got.result_line.length <= 500 && got.label.length <= 500);
});

test('segments split on unquoted operators and keep quoted words whole', () => {
  assert.deepEqual(segments(`a "b; c" 'd|e' f\\ g && h;i|j\nk`), [['a', 'b; c', 'd|e', 'f g'], ['h'], ['i'], ['j'], ['k']]);
});

test('isCommit', () => {
  for (const c of ['git commit -m x', 'git -c a=b commit --amend', 'git add . && git commit -qm "y"']) assert.ok(isCommit(c), c);
  for (const c of ['git status | grep commit', 'echo commit', 'git log; commit']) assert.equal(isCommit(c), false, c);
});

test('gh pr create: opened, from the stdout URL', () => {
  const out = 'Creating pull request for feat into main\n\nhttps://github.com/o/r/pull/42\n';
  assert.deepEqual(prEvent(bash('gh pr create --fill', out), { branch: () => 'feat' }), { action: 'opened', url: 'https://github.com/o/r/pull/42', number: 42, branch: 'feat' });
  assert.equal(prEvent(bash('gh pr create -H other --fill', out), { branch: () => 'feat' }).branch, 'other');
  assert.equal(prEvent(bash('gh pr create --head=other', out), { branch: () => 'feat' }).branch, 'other');
  assert.equal(prEvent(bash('git commit -m "gh pr create"', out)), null);
  assert.equal(prEvent(bash('gh pr create --fill', 'no url')), null);
  assert.equal(prEvent(failed('gh pr create', 'Exit code 1\nhttps://github.com/o/r/pull/9 already exists')), null);
});

test('gh pr merge -R takes its value, not the PR argument', () => {
  const seen = [];
  prEvent(bash('gh pr merge -R o/r 5 --squash'), { view: (cwd, arg) => { seen.push(arg); return { url: 'https://github.com/o/r/pull/5', number: 5 }; } });
  assert.deepEqual(seen, ['5']);
});

test('gh pr merge: merged, url from gh pr view of the argument', () => {
  const asked = [];
  const view = (cwd, arg) => {
    asked.push(arg);
    return 'https://github.com/o/r/pull/5';
  };
  const merged = { action: 'merged', url: 'https://github.com/o/r/pull/5', number: 5 };
  assert.deepEqual(prEvent(bash('gh pr merge 5 --squash'), { view }), merged);
  assert.deepEqual(prEvent(bash('gh pr merge --squash'), { view }), merged);
  assert.equal(prEvent(bash('gh pr merge --squash --delete-branch'), { view: () => assert.fail('gh sees the default branch now') }), null);
  assert.deepEqual(prEvent(bash('gh pr merge -s feat/x'), { view }), merged);
  assert.deepEqual(prEvent(bash('gh pr merge --squash --subject "Ship it" 7'), { view }), merged);
  assert.deepEqual(asked, ['5', null, 'feat/x', '7']);
  assert.deepEqual(prEvent(bash('gh pr merge https://github.com/o/r/pull/8 --squash'), { view: () => assert.fail('no gh needed') }), { action: 'merged', url: 'https://github.com/o/r/pull/8', number: 8 });
  assert.equal(prEvent(bash('gh pr merge 5 --auto --squash'), { view }), null);
  assert.equal(prEvent(bash('gh pr merge 5'), { view: () => null }), null);
  assert.equal(prEvent(bash('gh pr merge 5'), { view: () => 'not a url' }), null);
  assert.equal(prEvent(failed('gh pr merge 5', 'Exit code 1\n'), { view }), null);
});

test('gh pr merge resolves from the PRs recorded at create before asking gh', () => {
  const open = () => [{ branch: 'feat', url: 'https://github.com/o/r/pull/3' }, { branch: 'other', url: 'https://github.com/o/r/pull/4' }];
  const noGh = () => assert.fail('gh not needed');
  const three = { action: 'merged', url: 'https://github.com/o/r/pull/3', number: 3 };
  assert.deepEqual(prEvent(bash('gh pr merge --squash'), { open, branch: () => 'feat', view: noGh }), three);
  assert.deepEqual(prEvent(bash('gh pr merge 3'), { open, view: noGh }), three);
  assert.deepEqual(prEvent(bash('gh pr merge feat'), { open, view: noGh }), three);
  assert.deepEqual(prEvent(bash('gh pr merge -d --squash'), { open, branch: () => 'main', branches: () => ['main', 'other'], view: noGh }), three);
  assert.equal(prEvent(bash('gh pr merge -d'), { open, branch: () => 'main', branches: () => ['main'], view: noGh }), null);
  assert.equal(prEvent(bash('gh pr merge -d'), { open, branch: () => 'main', branches: () => null, view: noGh }), null);
});

test('sddStep: started before, finished after, only with a ledger', () => {
  const agent = (hook_event_name) => ({ hook_event_name, tool_name: 'Agent', tool_input: { description: `Task 3 ${SECRET}`, prompt: 'p', subagent_type: 'general-purpose' }, tool_use_id: 'toolu_9' });
  assert.deepEqual(sddStep(agent('PreToolUse'), true), { phase: 'started', label: 'Task 3 [redacted]' });
  assert.deepEqual(sddStep({ ...agent('PostToolUse'), tool_name: 'Task' }, true), { phase: 'finished', label: 'Task 3 [redacted]' });
  assert.equal(sddStep(agent('PreToolUse'), false), null);
  assert.equal(sddStep({ ...agent('PreToolUse'), tool_name: 'Bash' }, true), null);
  assert.equal(sddStep({ ...agent('PreToolUse'), tool_input: {} }, true), null);
  const bg = { ...agent('PostToolUse'), tool_input: { description: 'bg', run_in_background: true } };
  assert.equal(sddStep(bg, true), null);
  const launched = { ...agent('PostToolUse'), tool_response: { isAsync: true, status: 'async_launched', agentId: 'a1' } };
  assert.equal(sddStep(launched, true), null);
  for (const tool_response of [{ isAsync: true }, { status: 'async_launched' }]) assert.equal(sddStep({ ...launched, tool_response }, true), null);
  assert.deepEqual(sddStep({ ...bg, hook_event_name: 'PreToolUse' }, true), { phase: 'started', label: 'bg' });
});

test('ledgerPresent looks for .superpowers/sdd/*/progress.md', () => {
  const root = tmp('root');
  assert.equal(ledgerPresent(root), false);
  mkdirSync(join(root, '.superpowers', 'sdd', 'plan-a'), { recursive: true });
  assert.equal(ledgerPresent(root), false);
  writeFileSync(join(root, '.superpowers', 'sdd', 'plan-a', 'progress.md'), '# SDD ledger — plan: docs/p.md\n');
  assert.equal(ledgerPresent(root), true);
});

function signedIn() {
  const data = tmp('data');
  writeFileSync(join(data, 'account.json'), JSON.stringify({ region: 'eu', workspace: 'acme', workspaces: { acme: 'standalone' } }));
  return data;
}

function branchRepo(origin) {
  const dir = tmp('repo');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  if (origin) git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'checkout', '-q', '-b', 'feat/AB-1-x');
  return dir;
}

let n = 0;
function session(data, dir) {
  const ctx = { data, env: { EOCRM_ENDPOINTS: UNREACHABLE }, now: () => 1_000_000, spawned: 0 };
  ctx.spawnFlush = () => { ctx.spawned += 1; };
  const s = `det-${process.pid}-${++n}`;
  const fire = (event, extra) => handle(event, { session_id: s, cwd: dir, transcript_path: join(dir, 'none.jsonl'), hook_event_name: event, ...extra }, ctx);
  return { ctx, s, fire };
}
const events = (data, s, type) => readOutbox(data).filter((e) => e.sessionId === s && e.event?.type === type).map((e) => e.event);

test('a commit hook queues each new branch commit once', async () => {
  const data = signedIn();
  const dir = branchRepo(`https://user:${SECRET}@github.com/o/r.git`);
  git(dir, 'commit', '-q', '--allow-empty', '-m', `one ${SECRET}`);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'two');
  const { ctx, s, fire } = session(data, dir);
  await fire('SessionStart', { source: 'startup' });
  const spawned = ctx.spawned;
  await fire('PostToolUse', marked('git commit -m "fix" && make test', '3 passed'));
  const commits = events(data, s, 'commit');
  assert.deepEqual(commits.map((c) => [c.subject, c.repo]), [['one [redacted]', 'o/r'], ['two', 'o/r']]);
  assert.equal(commits[1].id, eventId('commit', git(dir, 'rev-parse', 'HEAD')));
  assert.equal(events(data, s, 'test_run').length, 1);
  assert.equal(ctx.spawned, spawned + 1);
  assert.equal(loadWorktree(data, worktreeOf(dir).key).reportedCommits.length, 2);
  assert.equal(loadWorktree(data, worktreeOf(dir).key).root, dir);
  writeOutbox(data, []);
  await fire('PostToolUse', bash('git commit -m again', ''));
  assert.equal(events(data, s, 'commit').length, 0);
});

test('a cd into the directory the hook already reports still detects the commit', async () => {
  const data = signedIn();
  const dir = branchRepo();
  const sub = join(dir, 'sub');
  mkdirSync(sub);
  const { s, fire } = session(data, sub);
  await fire('SessionStart', { source: 'startup' });
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'one');
  await fire('PostToolUse', bash('cd sub && git commit -m one', ''));
  assert.deepEqual(events(data, s, 'commit').map((c) => c.subject), ['one']);
});

test('an amend is a new sha, so it is reported as a new commit', async () => {
  const data = signedIn();
  const dir = branchRepo();
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'one');
  const { s, fire } = session(data, dir);
  await fire('SessionStart', { source: 'startup' });
  await fire('PostToolUse', bash('git commit -m one', ''));
  writeOutbox(data, []);
  git(dir, 'commit', '-q', '--allow-empty', '--amend', '-m', 'one amended');
  await fire('PostToolUse', bash('git commit --amend -m "one amended"', ''));
  assert.deepEqual(events(data, s, 'commit').map((c) => [c.sha, c.subject]), [[git(dir, 'rev-parse', 'HEAD'), 'one amended']]);
});

test('a failed Bash call that committed still reports the commit and a failing test run', async () => {
  const data = signedIn();
  const dir = branchRepo();
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'one');
  const { s, fire } = session(data, dir);
  await fire('SessionStart', { source: 'startup' });
  await fire('PostToolUseFailure', { ...failed('git commit -m one && npm test', 'Exit code 1\n1 failed\n'), tool_input: { command: 'git commit -m one && npm test', description: 'test: t' } });
  assert.equal(events(data, s, 'commit').length, 1);
  assert.deepEqual(events(data, s, 'test_run').map((t) => [t.exit_code, t.result_line]), [[1, '1 failed']]);
});

const them = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=o', '-c', 'user.email=o@o', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
// A bare origin with main, our clone, and a teammate's clone.
function shared() {
  const bare = tmp('bare');
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const seed = join(tmp('seed'), 's');
  git(bare, 'clone', '-q', bare, seed);
  git(seed, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'main');
  const dir = join(tmp('mine'), 'c');
  git(bare, 'clone', '-q', bare, dir);
  const mate = join(tmp('mate'), 'c');
  git(bare, 'clone', '-q', bare, mate);
  return { dir, mate };
}
const subjects = (data, s) => events(data, s, 'commit').map((c) => c.subject);

test('on main a session reports and records the commit it made, not ones from before it', async () => {
  const data = signedIn();
  const dir = tmp('repo');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'before');
  const { s, fire } = session(data, dir);
  await fire('SessionStart', { source: 'startup' });
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'mine');
  await fire('PostToolUse', bash('git commit -m mine', ''));
  assert.deepEqual(subjects(data, s), ['mine']);
  assert.deepEqual(loadRun(data, s).ownCommits, [git(dir, 'rev-parse', 'HEAD')]);
});

test('on main a teammate commit pulled during the session is not its own, even when it then commits', async () => {
  const data = signedIn();
  const { dir, mate } = shared();
  const { s, fire } = session(data, dir);
  await fire('SessionStart', { source: 'startup' });
  them(mate, 'commit', '-q', '--allow-empty', '-m', 'theirs');
  them(mate, 'push', '-q');
  git(dir, 'pull', '-q', '--ff-only');
  await fire('PostToolUse', bash('git pull --ff-only', ''));
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'mine');
  git(dir, 'push', '-q');
  await fire('PostToolUse', bash('git commit -m mine && git push', ''));
  assert.deepEqual(subjects(data, s), ['mine']);
  assert.deepEqual(loadRun(data, s).ownCommits, [git(dir, 'rev-parse', 'HEAD')]);
});

test('on main a pull and a commit that made nothing, in one call, claim nothing', async () => {
  const data = signedIn();
  const { dir, mate } = shared();
  const { s, fire } = session(data, dir);
  await fire('SessionStart', { source: 'startup' });
  them(mate, 'commit', '-q', '--allow-empty', '-m', 'theirs');
  them(mate, 'push', '-q');
  git(dir, 'pull', '-q', '--ff-only');
  await fire('PostToolUse', bash('git pull && git commit -m nothing', ''));
  assert.deepEqual(subjects(data, s), []);
  assert.deepEqual(loadRun(data, s).ownCommits ?? [], []);
});

test('two sessions in one checkout on main each report only their own commit', async () => {
  const data = signedIn();
  const { dir } = shared();
  const a = session(data, dir);
  const b = session(data, dir);
  await a.fire('SessionStart', { source: 'startup' });
  await b.fire('SessionStart', { source: 'startup' });
  await a.fire('UserPromptSubmit', { prompt: 'go on' });
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'by-A');
  await a.fire('PostToolUse', bash('git commit -m by-A', ''));
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'by-B');
  await b.fire('PostToolUse', bash('git commit -m by-B', ''));
  assert.deepEqual([subjects(data, a.s), subjects(data, b.s)], [['by-A'], ['by-B']]);
  assert.deepEqual(loadRun(data, b.s).ownCommits, [git(dir, 'rev-parse', 'HEAD')]);
});

test('a run from before the session HEAD was recorded claims no commit on main until it resumes', async () => {
  const data = signedIn();
  const { dir, mate } = shared();
  const { s, fire } = session(data, dir);
  await fire('SessionStart', { source: 'startup' });
  saveRun(data, s, { lastHead: undefined, ownCommits: undefined });
  them(mate, 'commit', '-q', '--allow-empty', '-m', 'theirs');
  them(mate, 'push', '-q');
  git(dir, 'pull', '-q', '--ff-only');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'unseen');
  git(dir, 'push', '-q');
  await fire('PostToolUse', bash('git pull && git commit -m unseen && git push', ''));
  assert.deepEqual(subjects(data, s), []);
  await fire('SessionStart', { source: 'resume' });
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'mine');
  git(dir, 'push', '-q');
  await fire('PostToolUse', bash('git commit -m mine && git push', ''));
  assert.deepEqual(subjects(data, s), ['mine']);
});

test('a session started in an empty repo reports its first commits', async () => {
  const data = signedIn();
  const dir = tmp('empty');
  git(dir, 'init', '-q', '-b', 'main');
  const { s, fire } = session(data, dir);
  await fire('SessionStart', { source: 'startup' });
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'first');
  await fire('PostToolUse', bash('git commit -m first', ''));
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'second');
  await fire('PostToolUse', bash('git commit -m second', ''));
  assert.deepEqual(subjects(data, s), ['first', 'second']);
});

test('a reported feature commit that reaches main is not reported again, nor a commit reset away', async () => {
  const data = signedIn();
  const { dir } = shared();
  const { s, fire } = session(data, dir);
  await fire('SessionStart', { source: 'startup' });
  git(dir, 'checkout', '-q', '-b', 'feat');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'f1');
  await fire('PostToolUse', bash('git commit -m f1', ''));
  git(dir, 'push', '-q', 'origin', 'feat:main');
  git(dir, 'fetch', '-q');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'f2');
  git(dir, 'reset', '-q', '--hard', 'HEAD~1');
  await fire('PostToolUse', bash('git commit -m f2 && git reset --hard HEAD~1', ''));
  assert.deepEqual(subjects(data, s), ['f1']);
});

test('test-run ids are unique per tool use and per run generation', async () => {
  const data = signedIn();
  const dir = branchRepo();
  const { s, fire } = session(data, dir);
  await fire('SessionStart', { source: 'startup' });
  await fire('PostToolUse', marked('npm test', '1 passed', undefined, { tool_use_id: 'a' }));
  await fire('PostToolUse', marked('npm test', '1 passed', undefined, { tool_use_id: 'b' }));
  const ids = events(data, s, 'test_run').map((t) => t.id);
  assert.equal(new Set(ids).size, 2);
  const gen1 = eventId('test_run', `${loadRun(data, s).clientRunId}:a`);
  assert.equal(ids[0], gen1);
  await fire('SessionEnd');
  writeOutbox(data, []);
  await fire('UserPromptSubmit');
  assert.equal(loadRun(data, s).generation, 1);
  await fire('PostToolUse', marked('npm test', '1 passed', undefined, { tool_use_id: 'a' }));
  assert.ok(!ids.includes(events(data, s, 'test_run').at(-1).id));
});

test('gh pr create queues an opened PR with repo and number and remembers it open', async () => {
  const data = signedIn();
  const dir = branchRepo();
  const { s, fire } = session(data, dir);
  await fire('SessionStart', { source: 'startup' });
  await fire('PostToolUse', bash('gh pr create --fill', 'https://github.com/o/r/pull/42\n'));
  const [pr] = events(data, s, 'pull_request');
  assert.deepEqual([pr.action, pr.url, pr.repo, pr.number, pr.id], ['opened', 'https://github.com/o/r/pull/42', 'o/r', 42, eventId('pull_request', 'opened:https://github.com/o/r/pull/42')]);
  assert.deepEqual(loadWorktree(data, worktreeOf(dir).key).openPrs, [{ branch: 'feat/AB-1-x', url: 'https://github.com/o/r/pull/42' }]);
  assert.equal(pr.branch, undefined);
  await fire('PostToolUse', bash('gh pr merge https://github.com/o/r/pull/42 --squash'));
  assert.deepEqual(events(data, s, 'pull_request').map((p) => p.action), ['opened', 'merged']);
  assert.deepEqual(loadWorktree(data, worktreeOf(dir).key).openPrs, []);
});

test('gh pr merge --delete-branch on a real branch resolves the PR recorded at create, without gh', async () => {
  const data = signedIn();
  const dir = branchRepo();
  const { ctx, s, fire } = session(data, dir);
  ctx.git = { exec: (cmd, args, opts) => (cmd === 'gh' ? assert.fail('gh not needed') : execFileSync(cmd, args, opts)) };
  await fire('SessionStart', { source: 'startup' });
  await fire('PostToolUse', bash('gh pr create --fill', 'https://github.com/o/r/pull/42\n'));
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'branch', '-q', '-D', 'feat/AB-1-x');
  await fire('PostToolUse', bash('gh pr merge --squash --delete-branch'));
  assert.deepEqual(events(data, s, 'pull_request').map((p) => [p.action, p.number]), [['opened', 42], ['merged', 42]]);
  assert.deepEqual(loadWorktree(data, worktreeOf(dir).key).openPrs, []);
});

test('hook git and gh work shares one 8 s budget, however many calls hang', async () => {
  const data = signedIn();
  const dir = branchRepo();
  const { ctx, s, fire } = session(data, dir);
  await fire('SessionStart', { source: 'startup' });
  let clock = 0;
  const calls = [];
  ctx.git = {
    now: () => clock,
    exec: (cmd, args, opts) => {
      calls.push([cmd, opts.timeout]);
      clock += opts.timeout;
      throw new Error('timed out');
    },
  };
  await fire('PostToolUse', marked('git commit -m x && gh pr merge 9 -d && npm test', '1 passed'));
  assert.ok(calls.length >= 2, JSON.stringify(calls));
  assert.ok(clock <= 8000, `${clock} ms over ${calls.length} calls`);
  assert.equal(events(data, s, 'test_run').length, 1);
});

test('budget caps each call at what is left and refuses once spent', () => {
  let clock = 0;
  const seen = [];
  const run = budget(1000, { now: () => clock, exec: (cmd, args, opts) => { seen.push(opts.timeout); clock += 700; return 'ok'; } });
  assert.equal(run('git', [], { timeout: 5000 }), 'ok');
  assert.equal(run('git', [], { timeout: 5000 }), 'ok');
  assert.throws(() => run('git', [], { timeout: 5000 }), /budget/);
  assert.deepEqual(seen, [1000, 300]);
});

test('a step without a tool_use_id still gets a unique id', async () => {
  const data = signedIn();
  const dir = branchRepo();
  mkdirSync(join(dir, '.superpowers', 'sdd', 'p'), { recursive: true });
  writeFileSync(join(dir, '.superpowers', 'sdd', 'p', 'progress.md'), '# SDD ledger — plan: docs/p.md\n');
  const { s, fire } = session(data, dir);
  await fire('SessionStart', { source: 'startup' });
  await fire('PreToolUse', { tool_name: 'Agent', tool_input: { description: 'a' } });
  await fire('PreToolUse', { tool_name: 'Agent', tool_input: { description: 'b' } });
  const ids = events(data, s, 'step').map((e) => e.id);
  assert.equal(new Set(ids).size, 2);
  assert.ok(!ids.includes(eventId('step', 'undefinedstarted')));
});

test('Agent dispatch queues started and finished steps only while a ledger exists', async () => {
  const data = signedIn();
  const dir = branchRepo();
  const { s, fire } = session(data, dir);
  await fire('SessionStart', { source: 'startup' });
  const agent = { tool_name: 'Agent', tool_input: { description: 'Task 2: outbox' }, tool_use_id: 'toolu_7' };
  await fire('PreToolUse', agent);
  assert.equal(events(data, s, 'step').length, 0);
  mkdirSync(join(dir, '.superpowers', 'sdd', 'p'), { recursive: true });
  writeFileSync(join(dir, '.superpowers', 'sdd', 'p', 'progress.md'), '# SDD ledger — plan: docs/p.md\n');
  await fire('PreToolUse', agent);
  await fire('PostToolUse', { ...agent, tool_response: {} });
  assert.deepEqual(events(data, s, 'step').map((e) => [e.phase, e.label, e.id]), [
    ['started', 'Task 2: outbox', eventId('step', 'toolu_7started')],
    ['finished', 'Task 2: outbox', eventId('step', 'toolu_7finished')],
  ]);
  writeOutbox(data, []);
  const bg = { tool_name: 'Agent', tool_input: { description: 'bg', run_in_background: true }, tool_use_id: 'toolu_8' };
  await fire('PreToolUse', bg);
  assert.deepEqual(events(data, s, 'step').map((e) => e.phase), ['started']);
  writeOutbox(data, []);
  await fire('PostToolUse', { ...bg, tool_response: {} });
  assert.deepEqual(events(data, s, 'step'), []);
  const subs = join(dir, 'none', 'subagents');
  mkdirSync(subs, { recursive: true });
  writeFileSync(join(subs, 'agent-a1.meta.json'), JSON.stringify({ description: 'bg', toolUseId: 'toolu_8', requestShape: 'background' }));
  writeFileSync(join(subs, 'agent-a2.meta.json'), JSON.stringify({ description: 'Task 2: outbox', toolUseId: 'toolu_7', requestShape: 'foreground' }));
  await fire('SubagentStop', { agent_id: 'a2', agent_transcript_path: join(subs, 'agent-a2.jsonl'), agent_type: 'general-purpose' });
  await fire('SubagentStop', { agent_id: 'a1', agent_transcript_path: '', agent_type: 'general-purpose' });
  assert.deepEqual(events(data, s, 'step').map((e) => [e.phase, e.label, e.id]), [['finished', 'bg', eventId('step', 'toolu_8finished')]]);
  writeOutbox(data, []);
  writeFileSync(join(subs, 'agent-a3.meta.json'), '{not json');
  for (const agent_id of ['a3', 'a4']) assert.deepEqual(await fire('SubagentStop', { agent_id, agent_transcript_path: '' }), {});
  assert.deepEqual(events(data, s, 'step'), []);
  const before = loadRun(data, s);
  const other = branchRepo();
  await fire('SubagentStop', { agent_id: 'a1', agent_transcript_path: '', cwd: other });
  const after = loadRun(data, s);
  assert.deepEqual([after.cwd, after.worktreeKey, after.generation, after.clientRunId], [before.cwd, before.worktreeKey, before.generation, before.clientRunId]);
  assert.deepEqual(events(data, s, 'step').map((e) => e.phase), ['finished']);
});

test('an ended run queues no detected events', async () => {
  const data = signedIn();
  const dir = branchRepo();
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'one');
  const { s, fire } = session(data, dir);
  await fire('SessionStart', { source: 'startup' });
  writeOutbox(data, []);
  await fire('SessionEnd');
  await fire('PostToolUse', marked('git commit -m one && npm test', '1 passed'));
  assert.deepEqual(readOutbox(data).filter((e) => e.sessionId === s && e.kind === 'event'), []);
});

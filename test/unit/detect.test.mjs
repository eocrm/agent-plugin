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
import { loadRun, loadWorktree, worktreeOf } from '../../lib/state.mjs';
import { eventId } from '../../lib/ids.mjs';

const UNREACHABLE = JSON.stringify({ issuer: 'http://127.0.0.1:9', api: 'http://127.0.0.1:9/{workspace}/api' });
const tmp = (p) => realpathSync.native(mkdtempSync(join(tmpdir(), `eocrm-${p}-`)));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
const SECRET = 'ghp_FAKEfakeFAKEfakeFAKEfakeFAKEfake0000';

const bash = (command, stdout = '', extra = {}) => ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '', interrupted: false, isImage: false }, tool_use_id: 'toolu_1', ...extra });
const failed = (command, error) => ({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_2', error, is_interrupt: false });

test('npm test: the last summary line, exit 0', () => {
  const out = ' RUN  v3\n\n ✓ a.test.js (3)\n\n Tests  3 passed (3)\n   Start at  10:00:00\n Duration  1.2s\n';
  assert.deepEqual(testRun(bash('npm test', out)), { command: 'npm test', result_line: 'Tests  3 passed (3)', exit_code: 0 });
});

test('a failure parses its exit code and reads output after the Exit code line', () => {
  assert.deepEqual(testRun(failed('make test', 'Exit code 1\nFAIL x\n2 failed, 5 passed\n')), { command: 'make test', result_line: '2 failed, 5 passed', exit_code: 1 });
  assert.deepEqual(testRun(failed('pytest', 'Exit code 2\n')), { command: 'pytest', result_line: '', exit_code: 2 });
  assert.equal(testRun(failed('pytest', 'Command timed out after 2m')), null);
  assert.equal(testRun({ ...failed('pytest', 'Exit code 1\n'), is_interrupt: true }), null);
});

test('no summary match falls back to the last non-empty line; ANSI colour and CRLF are stripped', () => {
  assert.equal(testRun(bash('go test ./...', 'building\r\ndone\r\n\r\n')).result_line, 'done');
  assert.equal(testRun(bash('npx vitest run', '\x1b[32m 4 passed\x1b[39m\nbye\n')).result_line, '4 passed');
  assert.equal(testRun(bash('jest', '', { tool_response: { stdout: '', stderr: 'Tests: 1 failed\n' } })).result_line, 'Tests: 1 failed');
});

test('the command matcher', () => {
  for (const c of ['make test FILTER=x', 'make e2e', 'npm run test', 'pnpm test', 'yarn test', 'npx playwright test', 'vendor/bin/pest', 'cargo test', 'go test ./...', 'node --test test/unit', 'dotnet test', './gradlew test', 'git commit -m "fix" && make test']) {
    assert.ok(testRun(bash(c, 'ok')), c);
  }
  for (const c of ['curl -u me:pw https://x', 'make testing', 'npm install', 'git commit -m "add tests"', 'echo latest']) assert.equal(testRun(bash(c, 'ok')), null, c);
});

test('test runs are matched by the command word of each segment, never inside quoted text', () => {
  for (const c of ['CI=1 npm test', 'sudo -E make test', 'time pytest -q', 'env -i FOO=1 cargo test', './vendor/bin/pest', '"C:\\tools\\vitest.cmd" run', 'cd api && make test FILTER=X', 'make test | tail -5', '(go test ./...)']) {
    assert.ok(testRun(bash(c, 'ok')), c);
  }
  for (const c of ['git commit -m "make test"', "echo 'npm test'", 'npm i -D vitest', 'cat jest.config.js', 'grep vitest package.json', 'git commit -m "fix" -m "run make test"']) {
    assert.equal(testRun(bash(c, 'ok')), null, c);
  }
});

test('segments split on unquoted operators and keep quoted words whole', () => {
  assert.deepEqual(segments(`a "b; c" 'd|e' f\\ g && h;i|j\nk`), [['a', 'b; c', 'd|e', 'f g'], ['h'], ['i'], ['j'], ['k']]);
});

test('background, interrupted and non-Bash calls are not test runs', () => {
  assert.equal(testRun(bash('npm test', 'ok', { tool_input: { command: 'npm test', run_in_background: true } })), null);
  assert.equal(testRun(bash('npm test', 'ok', { tool_response: { stdout: 'ok', interrupted: true } })), null);
  assert.equal(testRun({ ...bash('npm test', 'ok'), tool_name: 'Write' }), null);
});

test('test command and result line are scrubbed and capped', () => {
  const got = testRun(bash(`TOKEN=${SECRET} npm test ${'x'.repeat(600)}`, `1 passed ${SECRET}\n`));
  assert.doesNotMatch(JSON.stringify(got), /ghp_/);
  assert.ok(got.command.length <= 500 && got.result_line.length <= 500);
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
  assert.deepEqual(sddStep(bg, true), { phase: 'started', label: 'bg' });
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
  await fire('PostToolUse', bash('git commit -m "fix" && make test', '3 passed'));
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
  await fire('PostToolUseFailure', failed('git commit -m one && npm test', 'Exit code 1\n1 failed\n'));
  assert.equal(events(data, s, 'commit').length, 1);
  assert.deepEqual(events(data, s, 'test_run').map((t) => [t.exit_code, t.result_line]), [[1, '1 failed']]);
});

test('test-run ids are unique per tool use and per run generation', async () => {
  const data = signedIn();
  const dir = branchRepo();
  const { s, fire } = session(data, dir);
  await fire('SessionStart', { source: 'startup' });
  await fire('PostToolUse', bash('npm test', '1 passed', { tool_use_id: 'a' }));
  await fire('PostToolUse', bash('npm test', '1 passed', { tool_use_id: 'b' }));
  const ids = events(data, s, 'test_run').map((t) => t.id);
  assert.equal(new Set(ids).size, 2);
  const gen1 = eventId('test_run', `${loadRun(data, s).clientRunId}:a`);
  assert.equal(ids[0], gen1);
  await fire('SessionEnd');
  writeOutbox(data, []);
  await fire('UserPromptSubmit');
  assert.equal(loadRun(data, s).generation, 1);
  await fire('PostToolUse', bash('npm test', '1 passed', { tool_use_id: 'a' }));
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
  await fire('PostToolUse', bash('git commit -m x && gh pr merge 9 -d && npm test', '1 passed'));
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
  await fire('PostToolUse', { ...bg, tool_response: {} });
  assert.deepEqual(events(data, s, 'step').map((e) => e.phase), ['started']);
});

test('an ended run queues no detected events', async () => {
  const data = signedIn();
  const dir = branchRepo();
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'one');
  const { s, fire } = session(data, dir);
  await fire('SessionStart', { source: 'startup' });
  await fire('SessionEnd');
  await fire('PostToolUse', bash('git commit -m one && npm test', '1 passed'));
  assert.deepEqual(readOutbox(data).filter((e) => e.sessionId === s && e.kind === 'event'), []);
});

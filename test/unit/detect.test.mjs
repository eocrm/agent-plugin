import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { testRun, prEvent, isCommit, sddStep, ledgerPresent } from '../../lib/detect.mjs';
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
  assert.deepEqual(prEvent(bash('gh pr create --fill', out)), { action: 'opened', url: 'https://github.com/o/r/pull/42', number: 42 });
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
  assert.deepEqual(prEvent(bash('gh pr merge --squash --delete-branch'), { view }), merged);
  assert.deepEqual(prEvent(bash('gh pr merge -s feat/x'), { view }), merged);
  assert.deepEqual(prEvent(bash('gh pr merge --squash --subject "Ship it" 7'), { view }), merged);
  assert.deepEqual(asked, ['5', null, 'feat/x', '7']);
  assert.deepEqual(prEvent(bash('gh pr merge https://github.com/o/r/pull/8 --squash'), { view: () => assert.fail('no gh needed') }), { action: 'merged', url: 'https://github.com/o/r/pull/8', number: 8 });
  assert.equal(prEvent(bash('gh pr merge 5 --auto --squash'), { view }), null);
  assert.equal(prEvent(bash('gh pr merge 5'), { view: () => null }), null);
  assert.equal(prEvent(bash('gh pr merge 5'), { view: () => 'not a url' }), null);
  assert.equal(prEvent(failed('gh pr merge 5', 'Exit code 1\n'), { view }), null);
});

test('sddStep: started before, finished after, only with a ledger', () => {
  const agent = (hook_event_name) => ({ hook_event_name, tool_name: 'Agent', tool_input: { description: `Task 3 ${SECRET}`, prompt: 'p', subagent_type: 'general-purpose' }, tool_use_id: 'toolu_9' });
  assert.deepEqual(sddStep(agent('PreToolUse'), true), { phase: 'started', label: 'Task 3 [redacted]' });
  assert.deepEqual(sddStep({ ...agent('PostToolUse'), tool_name: 'Task' }, true), { phase: 'finished', label: 'Task 3 [redacted]' });
  assert.equal(sddStep(agent('PreToolUse'), false), null);
  assert.equal(sddStep({ ...agent('PreToolUse'), tool_name: 'Bash' }, true), null);
  assert.equal(sddStep({ ...agent('PreToolUse'), tool_input: {} }, true), null);
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
  writeOutbox(data, []);
  await fire('PostToolUse', bash('git commit --amend --no-edit', ''));
  assert.equal(events(data, s, 'commit').length, 0);
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
  assert.deepEqual(loadWorktree(data, worktreeOf(dir).key).openPrs, ['https://github.com/o/r/pull/42']);
  await fire('PostToolUse', bash('gh pr merge https://github.com/o/r/pull/42 --squash'));
  assert.deepEqual(events(data, s, 'pull_request').map((p) => p.action), ['opened', 'merged']);
  assert.deepEqual(loadWorktree(data, worktreeOf(dir).key).openPrs, []);
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

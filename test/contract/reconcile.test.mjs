import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { handle, runClient } from '../../lib/run.mjs';
import { flush } from '../../lib/flush.mjs';
import { saveRun } from '../../lib/state.mjs';
import { startFixtureServer } from '../support/fixture-server.mjs';

const tmp = (p) => realpathSync.native(mkdtempSync(join(tmpdir(), `eocrm-${p}-`)));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });
const PLAN = 'docs/superpowers/plans/p.md';

test('a run whose events already hold the plan and tick 1: reconcile at resume sends only tick 2', async (t) => {
  const conventions = { epic_type: null, subtask_type: null, bug_type: null, human_space: null, status_roles: [], priorities: [], epic_per_slice: false, subtask_per_pr: false, plan_import: true, keep_project_current: false, workflows: [] };
  const server = await startFixtureServer({ responses: { 'agentWorkConventions.show': { status: 200, body: conventions } } });
  t.after(() => server.close());
  const data = tmp('data');
  writeFileSync(join(data, 'account.json'), JSON.stringify({ region: 'eu', workspace: 'acme', workspaces: { acme: 'standalone' } }));
  const dir = tmp('repo');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dir, 'checkout', '-q', '-b', 'feat/AB-12-x');
  mkdirSync(join(dir, 'docs/superpowers/plans'), { recursive: true });
  writeFileSync(join(dir, PLAN), '### Task 1: One\n- [ ] a\n\n### Task 2: Two\n- [ ] b\n\n### Task 3: Three\n- [ ] c\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'plan');
  const ledger = join(dir, '.superpowers/sdd/p/progress.md');
  mkdirSync(join(dir, '.superpowers/sdd/p'), { recursive: true });
  writeFileSync(ledger, `# SDD ledger — plan: ${PLAN}\nTask 1: complete\n`);

  const tokens = { access_token: server.auth.access, refresh_token: server.auth.refresh, client_id: server.auth.clientId };
  const ctx = { data, env: server.endpointsEnv, now: Date.now, store: { get: async () => tokens, update: async () => null }, spawnFlush: () => {} };
  const go = () => flush({ data, deadlineMs: 5000, clientFor: runClient(ctx) });
  const input = { session_id: 'sess-r1', cwd: dir };
  const posted = () => server.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/events')).map((r) => r.body.events.map((e) => e.plan_key ?? e.type));

  await handle('SessionStart', { ...input, source: 'startup' }, ctx);
  await go();
  assert.deepEqual(posted(), [['plan', 'task-1', 'commit']]);

  appendFileSync(ledger, 'Task 2: complete\n');
  saveRun(data, 'sess-r1', { acked: {}, serverEventsRead: false });
  await handle('Stop', input, ctx);
  await go();
  assert.deepEqual(posted().slice(1), [['task-2']]);
  assert.equal(server.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/events')).length, 1);

  await handle('Stop', input, ctx);
  await go();
  assert.deepEqual(posted().slice(1), [['task-2']]);
});

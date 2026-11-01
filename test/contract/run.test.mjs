import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { handle, runClient } from '../../lib/run.mjs';
import { flush, fingerprint } from '../../lib/flush.mjs';
import { loadRun } from '../../lib/state.mjs';
import { readOutbox } from '../../lib/outbox.mjs';
import { startFixtureServer } from '../support/fixture-server.mjs';

const tmp = (p) => realpathSync.native(mkdtempSync(join(tmpdir(), `eocrm-${p}-`)));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });

async function setup(t, responses) {
  const server = await startFixtureServer({ responses });
  t.after(() => server.close());
  const data = tmp('data');
  writeFileSync(join(data, 'account.json'), JSON.stringify({ region: 'eu', workspace: 'acme', workspaces: { acme: 'standalone' } }));
  const dir = tmp('repo');
  git(dir, 'init', '-q', '-b', 'feat/AB-12-x');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dir, 'remote', 'add', 'origin', 'git@github.com:o/r.git');
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { model: 'model-a' } })}\n`);
  const tokens = { access_token: server.auth.access, refresh_token: server.auth.refresh, client_id: server.auth.clientId };
  const store = { get: async () => tokens, update: async () => null };
  const ctx = { data, env: server.endpointsEnv, now: Date.now, store, spawnFlush: () => {} };
  const calls = () => server.requests.map((r) => `${r.method} ${r.path.replace(/01JZRUN\d+/, ':id')}`);
  const go = () => flush({ data, deadlineMs: 5000, clientFor: runClient(ctx) });
  return { server, data, dir, transcript, ctx, calls, go };
}

test('start, events, finish: exactly POST runs, POST events, PATCH finished', async (t) => {
  const { server, dir, transcript, ctx, calls, go } = await setup(t);
  const input = { session_id: 'sess-c1', cwd: dir, transcript_path: transcript };
  assert.deepEqual(await handle('SessionStart', { ...input, source: 'startup' }, ctx), {});
  await handle('SessionEnd', { ...input, reason: 'other' }, ctx);
  const result = await go();
  assert.deepEqual(result, { sent: 3, rejected: [], retryable: false, signedOut: false });
  assert.deepEqual(calls(), ['POST /v1/agent-runs', 'POST /v1/agent-runs/:id/events', 'PATCH /v1/agent-runs/:id']);
  assert.deepEqual(server.requests[0].body, { branch: 'feat/AB-12-x', worktree: basename(dir), repo: 'o/r', client_run_id: 'sess-c1' });
  assert.deepEqual(server.requests[1].body.events.map((e) => [e.type, e.model]), [['usage', 'model-a']]);
  assert.deepEqual(server.requests[2].body, { state: 'finished' });
});

test('a resume after the finish was acked starts generation 1', async (t) => {
  const { server, dir, transcript, ctx, calls, go } = await setup(t);
  const input = { session_id: 'sess-c2', cwd: dir, transcript_path: transcript };
  await handle('SessionStart', input, ctx);
  await handle('SessionEnd', input, ctx);
  await go();
  await handle('SessionStart', { ...input, source: 'resume' }, ctx);
  await go();
  assert.deepEqual(calls().slice(3), ['POST /v1/agent-runs', 'POST /v1/agent-runs/:id/events']);
  assert.equal(server.requests[3].body.client_run_id, 'sess-c2.1');
  assert.notEqual(server.requests[4].path, server.requests[1].path);
});

test('link KEY after start sends PATCH {task}', async (t) => {
  const { server, dir, ctx, go } = await setup(t);
  const { main } = await import('../../scripts/eocrm.mjs');
  await handle('SessionStart', { session_id: 'sess-c3', cwd: dir }, ctx);
  await go();
  assert.equal(await main({ argv: ['link', 'AB-99', '--data', ctx.data], cwd: dir, env: ctx.env, out: () => {}, err: () => {}, spawnFlush: () => {} }), 0);
  await go();
  assert.deepEqual(server.requests.at(-1).body, { task: 'AB-99' });
});

test('a resume after its run file was pruned starts a new run, not the old one', async (t) => {
  const { server, data, dir, ctx, go } = await setup(t);
  const input = { session_id: 'sess-c4', cwd: dir };
  await handle('SessionStart', { ...input, source: 'startup' }, ctx);
  await handle('SessionEnd', input, ctx);
  await go();
  const firstId = loadRun(data, 'sess-c4').runId;
  const old = new Date(Date.now() - 8 * 86400000);
  utimesSync(join(data, 'runs', 'sess-c4.json'), old, old);
  await handle('SessionStart', { session_id: 'sess-c5', cwd: dir, source: 'startup' }, ctx);
  await handle('SessionStart', { ...input, source: 'resume' }, ctx);
  await go();
  const starts = server.requests.filter((r) => r.method === 'POST' && r.path === '/v1/agent-runs');
  assert.deepEqual(starts.map((r) => r.body.client_run_id), ['sess-c4', 'sess-c5', 'sess-c4.1']);
  assert.notEqual(loadRun(data, 'sess-c4').runId, firstId);
});

test('a rejected start is not re-sent until the run changes, and its record is kept once', async (t) => {
  const { server, data, dir, transcript, ctx, go } = await setup(t, { 'agentRun.store': { status: 422, body: { message: 'Bad.', errors: { branch: ['too long'] } } } });
  const { main } = await import('../../scripts/eocrm.mjs');
  const input = { session_id: 'sess-c6', cwd: dir };
  const starts = () => server.requests.filter((r) => r.path === '/v1/agent-runs').length;
  await handle('SessionStart', input, ctx);
  await go();
  await handle('PostToolUse', { ...input, transcript_path: transcript }, ctx);
  assert.ok(readOutbox(data).some((e) => e.sessionId === 'sess-c6'));
  await go();
  await go();
  assert.equal(starts(), 1);
  const run = loadRun(data, 'sess-c6');
  assert.equal(run.startBlocked, fingerprint(run.rejected[0]));
  assert.deepEqual(run.rejectedFingerprints, [fingerprint(run.rejected[0])]);
  await main({ argv: ['link', 'AB-5', '--data', data], cwd: dir, env: ctx.env, out: () => {}, err: () => {}, spawnFlush: () => {} });
  await go();
  assert.equal(starts(), 2);
  await handle('SessionStart', { ...input, source: 'resume' }, ctx);
  await go();
  assert.equal(starts(), 3);
  assert.equal(loadRun(data, 'sess-c6').rejected.length, 1);
});

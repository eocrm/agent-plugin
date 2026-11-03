import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay, startReplayServer, signedIn } from '../support/replay.mjs';

const file = (n) => new URL(`../replay/codex/${n}.jsonl`, import.meta.url).pathname;
const kinds = (log) => log.flatMap((r) => r.body?.events ?? []).map((e) => `${e.type}${e.kind ? `:${e.kind}` : ''}${e.phase ? `:${e.phase}` : ''}`);

async function run(name, harness) {
  const server = await startReplayServer();
  try {
    return { ...(await replay(file(name), { server, data: signedIn(), harness })), events: null };
  } finally {
    await server.close();
  }
}

test('a Codex session produces the same run events as its Claude equivalent', async () => {
  const codex = kinds((await run('session', 'codex')).log);
  const claude = kinds((await run('claude-equivalent', 'claude')).log);
  const shared = (k) => k.filter((t) => !t.startsWith('usage') && t !== 'waiting:idle');
  assert.deepEqual(shared(codex), shared(claude));
  const ended = (r) => r.log.some((x) => x.method === 'PATCH' && x.path.startsWith('/v1/agent-runs/'));
  assert.ok(ended(await run('session', 'codex')) && ended(await run('claude-equivalent', 'claude')));
  for (const t of ['commit', 'plan', 'waiting:permission', 'resumed']) assert.ok(codex.some((k) => k.startsWith(t)), t);
});

test('a Codex session sends usage per model and an idle waiting after its turn', async () => {
  const { log, outputs } = await run('session', 'codex');
  const events = log.flatMap((r) => r.body?.events ?? []);
  const usage = events.filter((e) => e.type === 'usage' && e.input_tokens !== undefined);
  assert.deepEqual(usage.map((e) => [e.model, e.input_tokens, e.output_tokens]).sort(), [['gpt-5-codex', 10, 5], ['gpt-5-mini', 20, 5]]);
  assert.ok(events.some((e) => e.type === 'waiting' && e.kind === 'idle'));
  assert.deepEqual(outputs, []);
});

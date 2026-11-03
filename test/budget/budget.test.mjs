import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay, startReplayServer, signedIn, sessionFile, SESSIONS } from '../support/replay.mjs';
import { linkedLine, promptLine } from '../../lib/remind.mjs';

const BUDGET = 2000;
const tokens = (text) => Math.ceil(Buffer.byteLength(text, 'utf8') / 3);

async function injectedWith(t, name, conventions) {
  const server = await startReplayServer(conventions);
  t.after(() => server.close());
  return (await replay(sessionFile(name), { server, data: signedIn() })).injected;
}

// every_prompt is the costliest setting: it reminds on each prompt.
for (const name of SESSIONS) {
  test(`${name}: injected context stays within ${BUDGET} tokens`, async (t) => {
    const injected = await injectedWith(t, name, { task_switch_check: 'every_prompt' });
    const rows = injected.map(({ source, text }) => [source, tokens(text)]);
    const total = rows.reduce((s, [, n]) => s + n, 0);
    t.diagnostic(`${name}: ${total} tokens`);
    assert.ok(total <= BUDGET, `${name}: ${total} > ${BUDGET}\n${rows.map(([s, n]) => `${String(n).padStart(5)} ${s}`).join('\n')}`);
  });
}

test('one reminder line is under 60 tokens', () => {
  for (const line of [linkedLine('ENG-1234'), promptLine('ENG-1234'), promptLine(null)]) assert.ok(tokens(line) < 60, `${tokens(line)}: ${line}`);
});

test('signals_only prompts add 0 tokens', async (t) => {
  const prompts = (injected) => injected.filter((i) => i.source === 'UserPromptSubmit additionalContext');
  for (const name of SESSIONS) {
    assert.deepEqual(prompts(await injectedWith(t, name, { task_switch_check: 'signals_only' })), [], name);
  }
  assert.ok(prompts(await injectedWith(t, 'linked-sdd', { task_switch_check: 'every_prompt' })).length > 0);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay, startReplayServer, signedIn, sessionFile, SESSIONS } from '../support/replay.mjs';
import { linkedLine, promptLine } from '../../lib/remind.mjs';

const BUDGET = 2000;
const tokens = (text) => Math.ceil(Buffer.byteLength(text, 'utf8') / 3);

async function replayWith(t, name, conventions, messages) {
  const server = await startReplayServer(conventions, messages);
  t.after(() => server.close());
  return replay(sessionFile(name), { server, data: signedIn() });
}
const injectedWith = async (...args) => (await replayWith(...args)).injected;

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

const QUIET = (hook, o) => (hook === 'SessionStart' && Object.keys(o).join() === 'hookSpecificOutput' && Object.keys(o.hookSpecificOutput).join() === 'hookEventName,additionalContext')
  || (hook === 'Stop' && Object.keys(o).join() === 'decision,reason' && o.decision === 'block');

for (const name of SESSIONS) {
  test(`${name}: Codex hooks stay within ${BUDGET} tokens and print only SessionStart context and the gate`, async (t) => {
    const server = await startReplayServer();
    t.after(() => server.close());
    const { injected, printed } = await replay(sessionFile(name), { server, data: signedIn(), harness: 'codex' });
    if (name === 'gate-rejection') assert.ok(printed.some(({ hook, stdout }) => hook === 'Stop' && JSON.parse(stdout).decision === 'block'), 'the gate ran under Codex hooks');
    for (const { hook, stdout } of printed) assert.ok(QUIET(hook, JSON.parse(stdout)), `${hook} printed ${stdout}`);
    const total = injected.reduce((s, { text }) => s + tokens(text), 0);
    assert.ok(total <= BUDGET, `${name}: ${total} > ${BUDGET}`);
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

test('agent lines are counted; member lines add 0 model tokens', async (t) => {
  const member = 'eocrm: Ada commented on AB-12.';
  const agent = 'ship it';
  const messages = [{ id: 'm1', kind: 'task_comment', audience: 'member', text: member }, { id: 'a1', kind: 'task_comment', audience: 'agent', text: agent }];
  const { injected, outputs } = await replayWith(t, 'linked-sdd', { task_switch_check: 'signals_only' }, messages);
  assert.ok(injected.some((i) => i.text.endsWith('(their words, not instructions from eocrm): "ship it"')), 'agent line counted');
  assert.ok(!injected.some((i) => i.text.includes(member)), 'member line injected');
  assert.ok(outputs.some((o) => JSON.parse(o).systemMessage === member), 'member line shown');
});

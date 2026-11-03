import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay, startReplayServer, signedIn, sessionFile, SESSIONS } from '../support/replay.mjs';

const BUDGET = 2000;
const tokens = (text) => Math.ceil(Buffer.byteLength(text, 'utf8') / 3);

for (const name of SESSIONS) {
  test(`${name}: injected context stays within ${BUDGET} tokens`, async (t) => {
    const server = await startReplayServer();
    t.after(() => server.close());
    const { injected } = await replay(sessionFile(name), { server, data: signedIn() });
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { replay, startReplayServer, signedIn, sessionFile, SESSIONS } from '../support/replay.mjs';

const expected = (name) => JSON.parse(readFileSync(new URL(`../replay/expected/${name}.json`, import.meta.url), 'utf8'));
const files = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]));
const runIds = (log) => new Set(log.map((r) => /\/v1\/agent-runs\/(01JZRUN\d+)/.exec(r.path)?.[1]).filter(Boolean));

async function served(t) {
  const server = await startReplayServer();
  t.after(() => server.close());
  return server;
}

for (const name of SESSIONS) {
  test(`${name}: the recording sends exactly the expected requests`, async (t) => {
    const server = await served(t);
    const { requests } = await replay(sessionFile(name), { server, data: signedIn() });
    assert.deepEqual(requests, expected(name));
  });

  test(`${name}: replaying it again changes nothing eocrm can see`, async (t) => {
    const server = await served(t);
    const first = await replay(sessionFile(name), { server, data: signedIn() });
    // A fresh data dir: on the same one an ended session resumes as generation 1, a new run by design.
    const again = await replay(sessionFile(name), { server, data: signedIn() });
    const events = again.log.filter((r) => r.method === 'POST' && r.path.endsWith('/events') && r.status === 200);
    assert.ok(events.length > 0);
    for (const r of events) assert.equal(r.response.duplicates, r.body.events.length, JSON.stringify(r.body.events.map((e) => e.id)));
    assert.deepEqual(again.log.filter((r) => r.method === 'POST' && r.path === '/v1/agent-runs').map((r) => r.status), [200]);
    assert.deepEqual(runIds(again.log), runIds(first.log));
  });

  test(`${name}: the token reaches no request body, file or output`, async (t) => {
    const server = await served(t);
    const data = signedIn();
    const { log, injected, outputs } = await replay(sessionFile(name), { server, data });
    const sent = log.map(({ headers: { authorization, ...headers }, ...r }) => {
      assert.equal(authorization, `Bearer ${server.auth.access}`);
      return { ...r, headers };
    });
    const haystacks = [JSON.stringify(sent), JSON.stringify(injected), ...outputs, ...files(data).map((f) => readFileSync(f, 'utf8'))];
    for (const token of [server.auth.access, server.auth.refresh]) {
      for (const h of haystacks) assert.ok(!h.includes(token), `${token} leaked`);
    }
  });
}

test('gate-rejection: Stop blocks once naming the refused commit, then lets the member continue', async (t) => {
  const server = await served(t);
  const { outputs } = await replay(sessionFile('gate-rejection'), { server, data: signedIn() });
  assert.deepEqual(outputs.map((o) => JSON.parse(o)), [{ decision: 'block', reason: 'eocrm refused 1 tracking update(s): commit "WIP" (422 subject). Fix what it names or tell the member; tracking continues.' }]);
});

test('permission-resume: one waiting per stretch, each resumed, and no notification text reaches eocrm', async (t) => {
  const server = await served(t);
  const { log } = await replay(sessionFile('permission-resume'), { server, data: signedIn() });
  const signals = log.flatMap((r) => r.body?.events ?? []).filter((e) => ['waiting', 'resumed'].includes(e.type)).map((e) => e.kind ?? e.type);
  assert.deepEqual(signals, ['permission', 'resumed', 'idle', 'resumed']);
  const sent = JSON.stringify(log.map((r) => r.body));
  for (const text of ['Permission needed', 'rm -rf', 'waiting for your input']) assert.ok(!sent.includes(text), text);
});

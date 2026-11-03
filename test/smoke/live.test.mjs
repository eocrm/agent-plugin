import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createClient } from '../../lib/api.mjs';
import { endpoints } from '../../lib/endpoints.mjs';

const { EOCRM_SMOKE_REGION: region, EOCRM_SMOKE_WORKSPACE: workspace, EOCRM_SMOKE_TASK: task, EOCRM_SMOKE_CLIENT_ID: clientId, EOCRM_SMOKE_REFRESH_TOKEN: refresh, EOCRM_SMOKE_TOKEN_OUT: out } = process.env;
const missing = Object.entries({ EOCRM_SMOKE_REGION: region, EOCRM_SMOKE_WORKSPACE: workspace, EOCRM_SMOKE_TASK: task, EOCRM_SMOKE_CLIENT_ID: clientId, EOCRM_SMOKE_REFRESH_TOKEN: refresh }).filter(([, v]) => !v).map(([k]) => k);
const ready = missing.length === 0;

// A nightly that silently skips looks healthy: in CI missing config is a failure (names only, never values).
if (!ready && process.env.CI) test('smoke config present', () => assert.fail(`missing ${missing.join(', ')}`));

test('live agent-run round trip', { skip: !ready && `missing ${missing.join(', ')}` }, async () => {
  let tokens = { access_token: 'stale', refresh_token: refresh, client_id: clientId, expires_at: 0 };
  const store = {
    get: async () => tokens,
    set: async (_k, t) => {
      tokens = t;
      if (out && t.refresh_token !== refresh) writeFileSync(out, t.refresh_token, { mode: 0o600 });
      return 'memory';
    },
    update: async (k, fn) => { const next = await fn(tokens); if (next && next !== tokens) await store.set(k, next); return next; },
  };
  const client = createClient({ endpoints: endpoints({ region }), workspace, store });
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const started = await client.startRun({ client_run_id: `smoke-${day}-${process.env.GITHUB_RUN_ID ?? Date.now()}`, task });
  assert.ok([200, 201].includes(started.status), `startRun ${started.status}`);
  const id = started.body.id;
  const events = [
    { id: 'smoke:plan', type: 'plan', source: 'todo', items: [{ key: 'k1', text: 'smoke' }] },
    { id: 'smoke:step', type: 'step', phase: 'started', label: 'smoke' },
    { id: 'smoke:commit', type: 'commit', sha: 'abc1234', subject: 'smoke' },
    { id: 'smoke:test', type: 'test_run', command: 'npm test', result_line: 'ok', exit_code: 0 },
  ];
  assert.equal((await client.recordEvents(id, events)).status, 200);
  const listed = await client.listEvents(id);
  // Listed events carry server ids, not our client ids: match by content (as lib/reconcile.mjs does).
  const items = listed.body.items;
  assert.deepEqual(items.map((e) => e.type).sort(), ['commit', 'plan', 'step', 'test_run']);
  const by = Object.fromEntries(items.map((e) => [e.type, e.payload ?? {}]));
  assert.ok(by.plan.items?.some((i) => i.text === 'smoke'), `plan ${JSON.stringify(by.plan)}`);
  assert.equal(by.step.label, 'smoke');
  assert.equal(by.commit.sha, 'abc1234');
  assert.equal(by.test_run.command, 'npm test');
  assert.equal((await client.recordEvents(id, events)).body.duplicates, 4);
  assert.equal((await client.updateRun(id, { state: 'finished' })).status, 200);
});

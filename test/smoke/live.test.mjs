import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createClient } from '../../lib/api.mjs';
import { endpoints } from '../../lib/endpoints.mjs';

const { EOCRM_SMOKE_REGION: region, EOCRM_SMOKE_WORKSPACE: workspace, EOCRM_SMOKE_TASK: task, EOCRM_SMOKE_CLIENT_ID: clientId, EOCRM_SMOKE_REFRESH_TOKEN: refresh, EOCRM_SMOKE_TOKEN_OUT: out } = process.env;
const ready = region && workspace && task && clientId && refresh;

test('live agent-run round trip', { skip: !ready && (console.log('::warning::smoke credentials not set (OPS-2)'), 'no credentials') }, async () => {
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
  const ids = listed.body.items.map((e) => e.id);
  for (const e of events) assert.ok(ids.includes(e.id), `missing ${e.id}`);
  assert.equal((await client.recordEvents(id, events)).body.duplicates, 4);
  assert.equal((await client.updateRun(id, { state: 'finished' })).status, 200);
});

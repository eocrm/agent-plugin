import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const SMOKE = fileURLToPath(new URL('test/smoke/live.test.mjs', root));
const json = (p) => JSON.parse(readFileSync(new URL(p, root), 'utf8'));

test('marketplace.json lists the plugin by relative source', () => {
  const m = json('.claude-plugin/marketplace.json');
  assert.equal(m.name, 'eocrm');
  assert.ok(m.owner?.name);
  assert.ok(m.description);
  assert.equal(m.plugins[0].source, './');
  assert.equal(m.plugins[0].name, json('.claude-plugin/plugin.json').name);
  assert.ok(m.plugins[0].description);
  assert.equal('version' in m.plugins[0], false);
});

test('eocrm-mcp is a separate tools-only plugin that eocrm depends on', () => {
  const m = json('.claude-plugin/marketplace.json');
  const entry = m.plugins.find((p) => p.name === 'eocrm-mcp');
  assert.equal(entry.source, './mcp');
  assert.equal(json('mcp/.claude-plugin/plugin.json').name, 'eocrm-mcp');
  assert.deepEqual(json('mcp/.mcp.json').mcpServers.eocrm, { type: 'http', url: 'https://mcp.eu.eocrm.io/' });
  assert.ok(json('.claude-plugin/plugin.json').dependencies.includes('eocrm-mcp'));
  assert.equal(existsSync(new URL('mcp/hooks', root)), false);
});

test('nightly smoke without credentials warns and exits 0', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('EOCRM_')));
  const r = spawnSync(process.execPath, [SMOKE], { env, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /::warning::smoke credentials not set \(OPS-2\)/);
});

test('nightly smoke keeps a rotated refresh token when the retried call fails', async (t) => {
  let calls = 0;
  const server = createServer((req, res) => {
    if (req.url === '/oauth/token') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }));
    }
    if (calls++ === 0) {
      res.statusCode = 401;
      return res.end();
    }
    req.socket.destroy();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const out = join(mkdtempSync(join(tmpdir(), 'eocrm-smoke-')), 'rotated');
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('EOCRM_'))),
    EOCRM_ENDPOINTS: JSON.stringify({ issuer: base, api: `${base}/{workspace}/api` }),
    EOCRM_SMOKE_REGION: 'eu', EOCRM_SMOKE_WORKSPACE: 'ws', EOCRM_SMOKE_TASK: 'T-1', EOCRM_SMOKE_CLIENT_ID: 'c', EOCRM_SMOKE_REFRESH_TOKEN: 'r1', EOCRM_SMOKE_TOKEN_OUT: out,
  };
  const code = await new Promise((r) => spawn(process.execPath, [SMOKE], { env, stdio: 'ignore' }).on('exit', r));
  assert.notEqual(code, 0);
  assert.equal(readFileSync(out, 'utf8'), 'r2');
});

test('no workflow installs or runs claude', () => {
  for (const f of ['ci.yml', 'nightly-smoke.yml']) {
    const text = readFileSync(new URL(`.github/workflows/${f}`, root), 'utf8');
    assert.doesNotMatch(text, /claude-code|npx claude|\bclaude -p\b/);
  }
});

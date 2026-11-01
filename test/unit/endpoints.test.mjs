import test from 'node:test';
import assert from 'node:assert/strict';
import { endpoints } from '../../lib/endpoints.mjs';

test('region endpoints', () => {
  const eu = endpoints({ region: 'eu', env: {} });
  assert.equal(eu.issuer, 'https://id.eu.eocrm.io');
  assert.equal(eu.api('acme'), 'https://acme.eu.eocrm.io/api');
  assert.equal(endpoints({ region: 'ru', env: {} }).api('a-1'), 'https://a-1.ru.eocrm.io/api');
});

test('unknown region throws', () => {
  for (const region of ['us', '', undefined, 'EU']) assert.throws(() => endpoints({ region, env: {} }), /region/);
});

test('bad slugs throw', () => {
  const eu = endpoints({ region: 'eu', env: {} });
  for (const slug of ['Acme', 'a..b', '-a', 'a-', '', 'a'.repeat(64), 'a/b', undefined]) assert.throws(() => eu.api(slug), /workspace/);
  assert.equal(eu.api('a'.repeat(63)), `https://${'a'.repeat(63)}.eu.eocrm.io/api`);
});

test('EOCRM_ENDPOINTS override wins', () => {
  const env = { EOCRM_ENDPOINTS: JSON.stringify({ issuer: 'http://127.0.0.1:9', api: 'http://127.0.0.1:9/{workspace}/api' }) };
  const e = endpoints({ region: 'eu', env });
  assert.equal(e.issuer, 'http://127.0.0.1:9');
  assert.equal(e.api('acme'), 'http://127.0.0.1:9/acme/api');
  assert.throws(() => e.api('Acme'), /workspace/);
});

test('malformed override throws', () => {
  for (const v of ['nope', '{}', JSON.stringify({ issuer: 'x', api: 'http://h/{workspace}/api' }), JSON.stringify({ issuer: 'http://h', api: 'http://h/api' })]) {
    assert.throws(() => endpoints({ region: 'eu', env: { EOCRM_ENDPOINTS: v } }), /EOCRM_ENDPOINTS/);
  }
});

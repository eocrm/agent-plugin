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
  assert.equal(e.key, 'http://127.0.0.1:9 http://127.0.0.1:9');
});

const override = (issuer, api) => ({ EOCRM_ENDPOINTS: JSON.stringify({ issuer, api }) });

test('dev host overrides are accepted', () => {
  const dev = endpoints({ region: 'eu', env: override('https://id.eocrm.local', 'https://{workspace}.eocrm.local/api') });
  assert.equal(dev.api('acme'), 'https://acme.eocrm.local/api');
  assert.equal(dev.key, 'https://id.eocrm.local https://{workspace}.eocrm.local');
  assert.equal(endpoints({ region: 'eu', env: override('https://id.eocrm-test.local', 'https://{workspace}.eocrm-test.local/api') }).api('a'), 'https://a.eocrm-test.local/api');
  for (const host of ['localhost:1', '[::1]:2']) {
    assert.equal(endpoints({ region: 'eu', env: override(`http://${host}`, `http://${host}/{workspace}/api`) }).issuer, `http://${host}`);
  }
});

test('overrides that could send the token elsewhere are refused', () => {
  const real = 'https://id.eu.eocrm.io';
  for (const [issuer, api] of [
    ['https://evil.example', 'https://{workspace}.evil.example/api'],
    ['http://id.eocrm.local', 'https://{workspace}.eocrm.local/api'],
    ['https://id.eocrm.local', 'http://{workspace}.eocrm.local/api'],
    [real, 'https://{workspace}.evil.example/api'],
    [real, 'https://{workspace}.eu.eocrm.io/api'],
    ['https://id.eocrm.local.evil.example', 'https://{workspace}.eocrm.local/api'],
    ['https://u:p@id.eocrm.local', 'https://{workspace}.eocrm.local/api'],
    ['https://id.eocrm.local', 'https://u@{workspace}.eocrm.local/api'],
    ['https://id.eocrm.local?x=1', 'https://{workspace}.eocrm.local/api'],
    ['https://id.eocrm.local', 'https://{workspace}.eocrm.local/api#x'],
    ['https://id.eocrm.local', 'https://{workspace}.eocrm.local/api?'],
    ['http://127.0.0.1.evil.example', 'http://127.0.0.1/{workspace}'],
    ['ftp://127.0.0.1', 'http://127.0.0.1/{workspace}'],
  ]) {
    assert.throws(() => endpoints({ region: 'eu', env: override(issuer, api) }), /EOCRM_ENDPOINTS/, `${issuer} ${api}`);
  }
});

test('the store key separates production from overrides', () => {
  const prod = endpoints({ region: 'eu', env: {} });
  assert.equal(prod.key, 'https://id.eu.eocrm.io https://{workspace}.eu.eocrm.io');
  assert.notEqual(endpoints({ region: 'eu', env: override('http://127.0.0.1:9', 'http://127.0.0.1:9/{workspace}/api') }).key, prod.key);
  assert.notEqual(endpoints({ region: 'ru', env: {} }).key, prod.key);
});

test('malformed override throws', () => {
  for (const v of ['nope', '{}', JSON.stringify({ issuer: 'x', api: 'http://h/{workspace}/api' }), JSON.stringify({ issuer: 'http://h', api: 'http://h/api' })]) {
    assert.throws(() => endpoints({ region: 'eu', env: { EOCRM_ENDPOINTS: v } }), /EOCRM_ENDPOINTS/);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialStore, spawnWithStdin } from '../../lib/credentials.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'eocrm-cred-'));
const ISSUER = 'https://id.eu.eocrm.io';
const TOKENS = { access_token: 'AT-sekrit-123', refresh_token: 'RT-sekrit-456', expires_at: 1767225600, client_id: 'cid' };

function fakeRun(handler) {
  const calls = [];
  const run = async (cmd, args, stdin) => {
    calls.push({ cmd, args, stdin });
    return handler(cmd, args, stdin);
  };
  return { run, calls };
}

const noSecretInArgs = (calls) => {
  for (const { args } of calls) {
    const joined = args.join(' ');
    for (const s of [TOKENS.access_token, TOKENS.refresh_token]) assert.ok(!joined.includes(s), `secret in args: ${joined}`);
    assert.ok(!joined.includes(Buffer.from(JSON.stringify(TOKENS)).toString('base64')), 'encoded secret in args');
  }
};

test('darwin set goes through security -i with the secret only on stdin', async () => {
  const kc = new Map();
  const { run, calls } = fakeRun((cmd, args, stdin) => {
    assert.equal(cmd, 'security');
    if (args[0] === '-i') {
      const m = stdin.match(/^add-generic-password -U -s "eocrm-claude-plugin" -a "([^"]+)" -w "([^"]+)"\n$/);
      assert.ok(m, stdin);
      kc.set(m[1], m[2]);
      return { code: 0, stdout: '' };
    }
    if (args[0] === 'find-generic-password') {
      const v = kc.get(args[args.indexOf('-a') + 1]);
      return v ? { code: 0, stdout: `${v}\n` } : { code: 44, stdout: '' };
    }
    if (args[0] === 'delete-generic-password') return { code: kc.delete(args[args.indexOf('-a') + 1]) ? 0 : 44, stdout: '' };
    throw new Error(`unexpected ${args}`);
  });
  const data = tmp();
  const store = credentialStore({ data, platform: 'darwin', run });
  assert.equal(await store.set(ISSUER, TOKENS), 'keychain');
  assert.deepEqual(calls[0].args, ['-i']);
  assert.ok(calls[0].stdin.includes(Buffer.from(JSON.stringify(TOKENS)).toString('base64')));
  assert.deepEqual(await store.get(ISSUER), TOKENS);
  assert.ok(calls.some((c) => c.args[0] === 'find-generic-password' && c.args.includes('-s') && c.args.includes('eocrm-claude-plugin')));
  noSecretInArgs(calls);
  assert.equal(existsSync(join(data, 'credentials.json')), false);
});

test('linux set calls secret-tool store with the secret on stdin', async () => {
  const kc = new Map();
  const { run, calls } = fakeRun((cmd, args, stdin) => {
    assert.equal(cmd, 'secret-tool');
    const account = args[args.indexOf('account') + 1];
    if (args[0] === 'store') { kc.set(account, stdin); return { code: 0, stdout: '' }; }
    if (args[0] === 'lookup') return kc.has(account) ? { code: 0, stdout: kc.get(account) } : { code: 1, stdout: '' };
    if (args[0] === 'clear') { kc.delete(account); return { code: 0, stdout: '' }; }
    throw new Error(`unexpected ${args}`);
  });
  const store = credentialStore({ data: tmp(), platform: 'linux', run });
  assert.equal(await store.set(ISSUER, TOKENS), 'keychain');
  assert.deepEqual(calls[0].args, ['store', '--label=eocrm-claude-plugin', 'service', 'eocrm-claude-plugin', 'account', ISSUER]);
  assert.ok(calls[0].stdin.length > 0);
  assert.deepEqual(await store.get(ISSUER), TOKENS);
  assert.deepEqual(calls.at(-1).args, ['lookup', 'service', 'eocrm-claude-plugin', 'account', ISSUER]);
  noSecretInArgs(calls);
});

test('win32 set runs a DPAPI script over stdin writing credentials.dpapi', async () => {
  let blob = null;
  const { run, calls } = fakeRun((cmd, args, stdin) => {
    assert.equal(cmd, 'powershell');
    assert.deepEqual(args, ['-NoProfile', '-NonInteractive', '-Command', '-']);
    if (stdin.includes('Unprotect(')) return { code: 0, stdout: blob ?? '' };
    if (stdin.includes('Protect(')) { blob = stdin.match(/Protect\(\[Convert\]::FromBase64String\('([^']+)'\)/)[1]; return { code: 0, stdout: '' }; }
    throw new Error('unexpected script');
  });
  const data = tmp();
  const store = credentialStore({ data, platform: 'win32', run });
  assert.equal(await store.set(ISSUER, TOKENS), 'keychain');
  const write = calls.find((c) => c.stdin.includes('ProtectedData]::Protect('));
  assert.ok(write.stdin.includes(Buffer.from(join(data, 'credentials.dpapi')).toString('base64')));
  assert.ok(write.stdin.includes('CurrentUser'));
  assert.deepEqual(await store.get(ISSUER), TOKENS);
  noSecretInArgs(calls);
});

test('win32 set keeps other issuers in the DPAPI blob', async () => {
  let blob = null;
  const { run } = fakeRun((cmd, args, stdin) => {
    if (stdin.includes('Unprotect(')) return { code: 0, stdout: blob ?? '' };
    blob = stdin.match(/Protect\(\[Convert\]::FromBase64String\('([^']+)'\)/)[1];
    return { code: 0, stdout: '' };
  });
  const store = credentialStore({ data: tmp(), platform: 'win32', run });
  await store.set(ISSUER, TOKENS);
  await store.set('https://id.ru.eocrm.io', { ...TOKENS, client_id: 'ru' });
  assert.deepEqual(await store.get(ISSUER), TOKENS);
  await store.del('https://id.ru.eocrm.io');
  assert.equal(await store.get('https://id.ru.eocrm.io'), null);
  assert.deepEqual(await store.get(ISSUER), TOKENS);
});

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`${platform}: a failing tool falls back to credentials.json at 0600`, async () => {
    const { run } = fakeRun(() => ({ code: 1, stdout: '' }));
    const data = tmp();
    const store = credentialStore({ data, platform, run });
    assert.equal(await store.set(ISSUER, TOKENS), 'file');
    const file = join(data, 'credentials.json');
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8'))[ISSUER], TOKENS);
    assert.deepEqual(await store.get(ISSUER), TOKENS);
  });
}

test('fallback rewrite tightens a pre-existing world-readable file', { skip: process.platform === 'win32' }, async () => {
  const data = tmp();
  const file = join(data, 'credentials.json');
  writeFileSync(file, '{}', { mode: 0o644 });
  const store = credentialStore({ data, platform: 'linux', run: async () => ({ code: 127, stdout: '' }) });
  await store.set(ISSUER, TOKENS);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('a keychain write drops a stale file copy', async () => {
  let ok = false;
  let stored = '';
  const { run } = fakeRun((cmd, args, stdin) => {
    if (!ok) return { code: 1, stdout: '' };
    if (args[0] === 'store') stored = stdin;
    return { code: 0, stdout: stored };
  });
  const data = tmp();
  const store = credentialStore({ data, platform: 'linux', run });
  assert.equal(await store.set(ISSUER, TOKENS), 'file');
  ok = true;
  assert.equal(await store.set(ISSUER, TOKENS), 'keychain');
  assert.equal(existsSync(join(data, 'credentials.json')), false);
});

test('del removes the keychain entry and the file', async () => {
  const kc = new Map();
  const { run, calls } = fakeRun((cmd, args, stdin) => {
    const account = args[args.indexOf('account') + 1];
    if (args[0] === 'store') { kc.set(account, stdin); return { code: 0, stdout: '' }; }
    if (args[0] === 'lookup') return kc.has(account) ? { code: 0, stdout: kc.get(account) } : { code: 1, stdout: '' };
    if (args[0] === 'clear') { kc.delete(account); return { code: 0, stdout: '' }; }
  });
  const data = tmp();
  writeFileSync(join(data, 'credentials.json'), JSON.stringify({ [ISSUER]: TOKENS }), { mode: 0o600 });
  const store = credentialStore({ data, platform: 'linux', run });
  await store.set(ISSUER, TOKENS);
  writeFileSync(join(data, 'credentials.json'), JSON.stringify({ [ISSUER]: TOKENS }), { mode: 0o600 });
  await store.del(ISSUER);
  assert.ok(calls.some((c) => c.args[0] === 'clear' && c.args.includes(ISSUER)));
  assert.equal(kc.size, 0);
  assert.equal(existsSync(join(data, 'credentials.json')), false);
  assert.equal(await store.get(ISSUER), null);
});

test('darwin del calls delete-generic-password', async () => {
  const { run, calls } = fakeRun(() => ({ code: 0, stdout: '' }));
  await credentialStore({ data: tmp(), platform: 'darwin', run }).del(ISSUER);
  assert.deepEqual(calls[0].args, ['delete-generic-password', '-s', 'eocrm-claude-plugin', '-a', ISSUER]);
});

test('get returns null for a missing or corrupt entry', async () => {
  const data = tmp();
  writeFileSync(join(data, 'credentials.json'), 'not json', { mode: 0o600 });
  const store = credentialStore({ data, platform: 'linux', run: async () => ({ code: 0, stdout: '%%%garbage' }) });
  assert.equal(await store.get(ISSUER), null);
});

test('an issuer that could break the security -i line is refused', async () => {
  const store = credentialStore({ data: tmp(), platform: 'darwin', run: async () => ({ code: 0, stdout: '' }) });
  await assert.rejects(store.set('https://x" -w "y', TOKENS), /issuer/);
});

test('a keychain write that does not read back falls back to the file', async () => {
  const store = credentialStore({ data: tmp(), platform: 'darwin', run: async () => ({ code: 0, stdout: '' }) });
  assert.equal(await store.set(ISSUER, TOKENS), 'file');
});

test('spawnWithStdin pipes stdin, returns stdout and maps a missing binary to -1', async () => {
  const r = await spawnWithStdin(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], 'hello');
  assert.deepEqual(r, { code: 0, stdout: 'hello' });
  assert.equal((await spawnWithStdin('eocrm-no-such-binary', [], 'x')).code, -1);
});

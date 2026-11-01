import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { withLock, readJson, writeJsonAtomic } from './state.mjs';

const SERVICE = 'eocrm-claude-plugin';
const PRIVATE = { mode: 0o600 };
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-Command', '-'];

export function spawnWithStdin(cmd, args, stdin = '') {
  return new Promise((resolve) => {
    const done = (code, stdout = '') => resolve({ code, stdout });
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'], timeout: 15000, windowsHide: true });
    } catch {
      return done(-1);
    }
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
    child.stdin.on('error', () => {});
    child.on('error', () => done(-1));
    child.on('close', (code) => done(code ?? -1, out));
    child.stdin.end(stdin);
  });
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function asTokens(v) {
  return v && typeof v === 'object' && typeof v.access_token === 'string' ? v : null;
}

function decode(s) {
  try {
    return asTokens(JSON.parse(Buffer.from(s.trim(), 'base64').toString('utf8')));
  } catch {
    return null;
  }
}

function lineTool(call, { set, get, del }) {
  return {
    async get(issuer) {
      const r = await call(...get(issuer));
      return r.code === 0 && r.stdout.trim() ? decode(r.stdout) : null;
    },
    async set(issuer, tokens) {
      const secret = b64(JSON.stringify(tokens));
      if ((await call(...set(issuer, secret))).code !== 0) return false;
      const r = await call(...get(issuer));
      return r.code === 0 && r.stdout.trim() === secret;
    },
    async del(issuer) {
      await call(...del(issuer));
    },
  };
}

const darwin = (call) => lineTool(call, {
  set: (a, s) => ['security', ['-i'], `add-generic-password -U -s "${SERVICE}" -a "${a}" -w "${s}"\n`],
  get: (a) => ['security', ['find-generic-password', '-s', SERVICE, '-a', a, '-w']],
  del: (a) => ['security', ['delete-generic-password', '-s', SERVICE, '-a', a]],
});

const linux = (call) => lineTool(call, {
  set: (a, s) => ['secret-tool', ['store', `--label=${SERVICE}`, 'service', SERVICE, 'account', a], s],
  get: (a) => ['secret-tool', ['lookup', 'service', SERVICE, 'account', a]],
  del: (a) => ['secret-tool', ['clear', 'service', SERVICE, 'account', a]],
});

function win32(call, data) {
  const path = join(data, 'credentials.dpapi');
  const ps = (lines) => call('powershell', PS_ARGS, `${[
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(path)}'))`,
    ...lines,
  ].join('\n')}\n\n`);
  const read = async () => {
    const r = await ps(["if (Test-Path -LiteralPath $p) { [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($p),$null,'CurrentUser')) }"]);
    if (r.code !== 0) return null;
    if (!r.stdout.trim()) return {};
    try {
      return JSON.parse(Buffer.from(r.stdout.trim(), 'base64').toString('utf8'));
    } catch {
      return null;
    }
  };
  const write = async (map) => {
    if (!Object.keys(map).length) {
      rmSync(path, { force: true });
      return true;
    }
    const json = JSON.stringify(map);
    const r = await ps([
      `try { [IO.File]::WriteAllBytes($p+'.tmp',[Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String('${b64(json)}'),$null,'CurrentUser')); Move-Item -LiteralPath ($p+'.tmp') -Destination $p -Force } catch { exit 1 }`,
    ]);
    return r.code === 0 && JSON.stringify(await read()) === json;
  };
  return {
    async get(issuer) {
      return asTokens((await read())?.[issuer]);
    },
    async set(issuer, tokens) {
      const map = await read();
      return map !== null && write({ ...map, [issuer]: tokens });
    },
    async del(issuer) {
      const map = await read();
      if (map && issuer in map) {
        delete map[issuer];
        await write(map);
      }
    },
  };
}

function checkIssuer(issuer) {
  if (typeof issuer !== 'string' || !/^https?:\/\/[^\s"'\\]+$/.test(issuer)) throw new Error('eocrm: invalid issuer');
}

export function credentialStore({ data, platform = process.platform, run = spawnWithStdin }) {
  const call = async (...a) => {
    try {
      return await run(...a);
    } catch {
      return { code: -1, stdout: '' };
    }
  };
  const keychain = { darwin, linux, win32 }[platform]?.(call, data) ?? null;
  const file = join(data, 'credentials.json');
  const readFile = () => {
    const map = readJson(file, {});
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  };
  const dropFromFile = (issuer) => {
    const map = readFile();
    if (!(issuer in map)) return;
    delete map[issuer];
    if (Object.keys(map).length) writeJsonAtomic(file, map, PRIVATE);
    else rmSync(file, { force: true });
  };
  const locked = (fn) => withLock(join(data, 'credentials.lock'), fn);

  return {
    async get(issuer) {
      checkIssuer(issuer);
      return (keychain && await keychain.get(issuer)) ?? asTokens(readFile()[issuer]);
    },
    async set(issuer, tokens) {
      checkIssuer(issuer);
      return locked(async () => {
        if (keychain && await keychain.set(issuer, tokens)) {
          dropFromFile(issuer);
          return 'keychain';
        }
        writeJsonAtomic(file, { ...readFile(), [issuer]: tokens }, PRIVATE);
        return 'file';
      });
    },
    async del(issuer) {
      checkIssuer(issuer);
      await locked(async () => {
        if (keychain) await keychain.del(issuer);
        dropFromFile(issuer);
      });
    },
  };
}

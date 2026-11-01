import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { withLock, readJson, writeJsonAtomic, remove } from './state.mjs';

const SERVICE = 'eocrm-claude-plugin';
const PRIVATE = { mode: 0o600 };
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-Command', '-'];

export function spawnWithStdin(cmd, args, stdin = '', { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const done = (code, stdout = '') => resolve({ code, stdout });
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'], timeout: timeoutMs, windowsHide: true });
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
    async get(issuer, opts) {
      const [cmd, args] = get(issuer);
      const r = await call(cmd, args, '', opts);
      return r.code === 0 && r.stdout.trim() ? decode(r.stdout) : null;
    },
    async set(issuer, tokens) {
      const secret = b64(JSON.stringify(tokens));
      const cmd = set(issuer, secret);
      if (!cmd || (await call(...cmd)).code !== 0) return false;
      const r = await call(...get(issuer));
      return r.code === 0 && r.stdout.trim() === secret;
    },
    async del(issuer) {
      await call(...del(issuer));
    },
  };
}

const SECURITY_LINE_MAX = 3500;

const darwin = (call) => lineTool(call, {
  set: (a, s) => {
    const line = `add-generic-password -U -s "${SERVICE}" -a "${a}" -w "${s}"\n`;
    return Buffer.byteLength(line) > SECURITY_LINE_MAX ? null : ['security', ['-i'], line];
  },
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
  const ps = (line, opts) => call('powershell', PS_ARGS, `$ErrorActionPreference='Stop'\nAdd-Type -AssemblyName System.Security\n${line}\n\n`, opts);
  const dpapi = async (fn, b64in, opts) => {
    const r = await ps(`[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${fn}([Convert]::FromBase64String('${b64in}'),$null,'CurrentUser'))`, opts);
    return r.code === 0 ? r.stdout.trim() : null;
  };
  const read = async (opts) => {
    if (!existsSync(path)) return {};
    const { blob } = readJson(path, {});
    if (typeof blob !== 'string' || !BASE64.test(blob)) return null;
    const plain = await dpapi('Unprotect', blob, opts);
    try {
      return plain === null ? null : JSON.parse(Buffer.from(plain, 'base64').toString('utf8'));
    } catch {
      return null;
    }
  };
  const write = async (map) => {
    if (!Object.keys(map).length) {
      remove(path);
      return true;
    }
    const json = JSON.stringify(map);
    const blob = await dpapi('Protect', b64(json));
    if (blob === null) return false;
    try {
      writeJsonAtomic(path, { blob }, PRIVATE);
    } catch {
      return false;
    }
    return JSON.stringify(await read()) === json;
  };
  return {
    async get(issuer, opts) {
      return asTokens((await read(opts))?.[issuer]);
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
  const locked = (fn, opts) => withLock(join(data, 'credentials.lock'), fn, opts);
  const read = async (issuer, timeoutMs) => (keychain && await keychain.get(issuer, timeoutMs ? { timeoutMs } : undefined)) ?? asTokens(readFile()[issuer]);
  const save = async (issuer, tokens) => {
    if (keychain && await keychain.set(issuer, tokens)) {
      dropFromFile(issuer);
      return 'keychain';
    }
    try {
      await keychain?.del(issuer);
    } catch {
      // best effort: the file write below must still happen
    }
    writeJsonAtomic(file, { ...readFile(), [issuer]: tokens }, PRIVATE);
    return 'file';
  };

  return {
    async get(issuer, { timeoutMs } = {}) {
      checkIssuer(issuer);
      return read(issuer, timeoutMs);
    },
    async set(issuer, tokens) {
      checkIssuer(issuer);
      return locked(() => save(issuer, tokens));
    },
    async update(issuer, fn, { timeoutMs } = {}) {
      checkIssuer(issuer);
      return locked(async () => {
        const latest = await read(issuer, timeoutMs);
        const next = await fn(latest);
        if (next && next !== latest) await save(issuer, next);
        return next;
      }, timeoutMs ? { giveUpMs: timeoutMs } : undefined);
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

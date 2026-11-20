import { cpSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { git, remove, writeFileAtomic } from '../state.mjs';
import { VERSION } from '../api.mjs';

export const HOOKS = ['post-commit', 'pre-push', 'post-checkout'];
const MARK = '# eocrm-cli';
const CREATED = `${MARK}: created by eocrm init`;
const SH = /^#!\s*(?:\/usr\/bin\/env\s+(?:-S\s+)?)?(?:\/(?:usr\/)?(?:local\/)?bin\/)?(?:sh|bash|dash|zsh|ksh)\b/;
const PACKAGE = fileURLToPath(new URL('../../', import.meta.url));
const SHIPPED = ['package.json', 'scripts/cli.mjs', 'scripts/eocrm.mjs', 'hooks/dispatch.mjs', 'lib'];

export const launcherOf = (data) => join(data, 'bin', 'eocrm.mjs');

// Git for Windows runs hooks under its own sh: forward slashes, single quotes.
export function shq(path, platform = process.platform) {
  const p = platform === 'win32' ? path.replace(/\\/g, '/') : path;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

// One line, so uninstall removes exactly it; never reads the hook's stdin (pre-push refs) nor fails the hook.
export function hookLine(name, { node = process.execPath, launcher, data, platform = process.platform }) {
  return `( L=${shq(launcher, platform)}; [ -f "$L" ] || exit 0; N=${shq(node, platform)}; [ -x "$N" ] || N=node; "$N" "$L" hook ${name} --data ${shq(data, platform)} "$@" </dev/null >/dev/null 2>&1 ) || : ${MARK}`;
}

// A versioned copy under the data dir plus a launcher that imports it: hooks keep working after npx's cache is collected.
export function installCopy(data, { from = PACKAGE, version = VERSION } = {}) {
  const bin = join(data, 'bin');
  const dest = join(bin, version);
  if (resolve(from) !== resolve(dest)) {
    const tmp = `${dest}.${randomBytes(4).toString('hex')}.tmp`;
    mkdirSync(tmp, { recursive: true });
    for (const f of SHIPPED) cpSync(join(from, f), join(tmp, f), { recursive: true });
    remove(dest);
    renameSync(tmp, dest);
  }
  writeFileAtomic(launcherOf(data), `await import(${JSON.stringify(`./${version}/scripts/cli.mjs`)});\n`);
  for (const old of readdirSync(bin)) if (old !== version && old !== 'eocrm.mjs' && !old.startsWith(`${version}.`)) remove(join(bin, old));
  return launcherOf(data);
}

export function hooksDir(cwd) {
  const dir = git(cwd, ['rev-parse', '--git-path', 'hooks']);
  if (!dir) throw Object.assign(new Error('not a git repository'), { exitCode: 2 });
  return resolve(cwd, dir);
}

// latin1 round-trips any bytes, so uninstall restores the file exactly.
const read = (file) => readFileSync(file, 'latin1');
const write = (file, text, opts) => writeFileSync(file, text, { encoding: 'latin1', ...opts });
const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
const strip = (text) => text.split(/(?<=\n)/).filter((l) => !l.trimEnd().endsWith(MARK)).join('');

// Into an existing sh hook (hand-written, husky's, lefthook's): one line after the shebang.
export function install(cwd, opts) {
  const dir = hooksDir(cwd);
  mkdirSync(dir, { recursive: true });
  const done = [];
  const skipped = [];
  for (const name of HOOKS) {
    const file = join(dir, name);
    const line = hookLine(name, opts);
    const text = existsSync(file) ? read(file) : null;
    if (text === null || text.includes(CREATED)) {
      write(file, `#!/bin/sh\n${CREATED}\n${line}\n`, { mode: 0o755 });
      done.push(name);
      continue;
    }
    const clean = strip(text);
    const [first, ...rest] = clean.split(/(?<=\n)/);
    if (first.startsWith('#!') && !SH.test(first)) {
      skipped.push(name);
      continue;
    }
    const eol = eolOf(clean);
    write(file, first.startsWith('#!') ? `${first}${first.endsWith('\n') ? '' : eol}${line}${eol}${rest.join('')}` : `${line}${eol}${clean}`);
    done.push(name);
  }
  return { dir, done, skipped };
}

export function uninstall(cwd) {
  const dir = hooksDir(cwd);
  const removed = [];
  for (const name of HOOKS) {
    const file = join(dir, name);
    let text;
    try {
      text = read(file);
    } catch {
      continue;
    }
    if (text.includes(CREATED)) unlinkSync(file);
    else if (strip(text) !== text) write(file, strip(text));
    else continue;
    removed.push(name);
  }
  return { dir, removed };
}

export function installed(cwd) {
  try {
    const dir = hooksDir(cwd);
    return HOOKS.filter((n) => existsSync(join(dir, n)) && read(join(dir, n)).includes(MARK));
  } catch {
    return [];
  }
}

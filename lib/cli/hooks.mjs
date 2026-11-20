import { appendFileSync, cpSync, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { git, remove, worktreeOf, writeFileAtomic } from '../state.mjs';
import { VERSION } from '../api.mjs';

export const HOOKS = ['post-commit', 'pre-push', 'post-checkout'];
const MARK = '# eocrm-cli';
const CREATED = `# created by eocrm init ${MARK}`;
const SHEBANG = '#!/bin/sh\n';
const SH = /^#!\s*(?:\/usr\/bin\/env\s+(?:-S\s+)?)?(?:\/(?:usr\/)?(?:local\/)?bin\/)?(?:sh|bash|dash|zsh|ksh)\b/;
const LOCAL_SCOPES = new Set(['local', 'worktree']);
const LEFTHOOK = ['lefthook.yml', '.lefthook.yml', 'lefthook.yaml', '.lefthook.yaml'];
const LEFTHOOK_LOCAL = ['lefthook-local.yml', '.lefthook-local.yml', 'lefthook-local.yaml', '.lefthook-local.yaml'];
const PACKAGE = fileURLToPath(new URL('../../', import.meta.url));
const SHIPPED = ['package.json', 'scripts/cli.mjs', 'scripts/eocrm.mjs', 'hooks/dispatch.mjs', 'lib'];
const LAUNCH = /^await import\("\.\/([^"/]+)\/scripts\/cli\.mjs"\);$/m;

export const launcherOf = (data) => join(data, 'bin', 'eocrm.mjs');

// Git for Windows runs hooks under its own sh: forward slashes, single quotes.
export function shq(path, platform = process.platform) {
  const p = platform === 'win32' ? path.replace(/\\/g, '/') : path;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

// Never reads the hook's stdin (pre-push refs), never fails the hook, leaks no variables.
function hookCommand(name, { node = process.execPath, launcher, data, platform = process.platform }, args) {
  return `( L=${shq(launcher, platform)}; [ -f "$L" ] || exit 0; N=${shq(node, platform)}; [ -x "$N" ] || N=node; "$N" "$L" hook ${name} --data ${shq(data, platform)} ${args} </dev/null >/dev/null 2>&1 ) || :`;
}

export const hookLine = (name, opts) => `${hookCommand(name, opts, '"$@"')} ${MARK}`;

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
  for (const old of readdirSync(bin)) if (old !== version && old !== 'eocrm.mjs') remove(join(bin, old));
  return launcherOf(data);
}

// The version the launcher points at, or null when it or its copy is gone.
export function launcherTarget(data) {
  try {
    const version = LAUNCH.exec(readFileSync(launcherOf(data), 'utf8'))?.[1];
    return version && existsSync(join(data, 'bin', version, 'scripts', 'cli.mjs')) ? version : null;
  } catch {
    return null;
  }
}

export function hooksDir(cwd) {
  const dir = git(cwd, ['rev-parse', '--git-path', 'hooks']);
  if (!dir) throw Object.assign(new Error('not a git repository'), { exitCode: 2 });
  return resolve(cwd, dir);
}

// The config scope of core.hooksPath: null when unset; global or system means other repositories share the dir.
export function hooksScope(cwd) {
  const scope = git(cwd, ['config', '--show-scope', '--get', 'core.hooksPath']).split('\t')[0];
  return scope ? { scope, shared: !LOCAL_SCOPES.has(scope) } : null;
}

// latin1 round-trips any bytes, so uninstall restores the file exactly.
const read = (file) => readFileSync(file, 'latin1');
const write = (file, text, opts) => writeFileSync(file, text, { encoding: 'latin1', ...opts });
const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
const strip = (text) => text.split(/(?<=\n)/).filter((l) => !l.trimEnd().endsWith(MARK)).join('');
const tracked = (cwd, file) => Boolean(git(cwd, ['ls-files', '--error-unmatch', '--', file]));

// Our lines go after the shebang, or first when there is none.
function withLines(text, lines) {
  const eol = eolOf(text);
  const add = lines.map((l) => `${l}${eol}`).join('');
  const [first = '', ...rest] = text.split(/(?<=\n)/);
  return first.startsWith('#!') ? `${first}${first.endsWith('\n') ? '' : eol}${add}${rest.join('')}` : `${add}${text}`;
}

function refusal(cwd, file, text) {
  if (tracked(cwd, file)) return 'tracked in git, so eocrm will not write local paths into it';
  if ([...text.slice(0, 512)].some((c) => (c < ' ' && !'\t\n\r\f\v\x1b'.includes(c)) || c === '\x7f')) return 'not a script';
  if (process.platform !== 'win32' && !(statSync(file).mode & 0o111)) return 'not executable, so git does not run it';
  if (text.startsWith('#!') && !SH.test(text)) return 'not a shell script';
  return null;
}

const lefthookLocal = (root) => (LEFTHOOK.some((f) => existsSync(join(root, f))) ? LEFTHOOK_LOCAL.map((f) => join(root, f)).find((f) => existsSync(f)) ?? join(root, LEFTHOOK_LOCAL[0]) : null);
const excludeOf = (cwd) => resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'info/exclude']));
const excludeLines = (root, file) => `${MARK}\n/${file.slice(root.length + 1).replace(/\\/g, '/')}\n`;
const yamlQuoted = (s) => `'${s.replace(/'/g, "''")}'`;

// lefthook rewrites its hook files on every install; lefthook-local.yml keeps the command across that.
function installLefthook(cwd, root, opts) {
  const file = lefthookLocal(root);
  if (!file) return null;
  if (tracked(cwd, file)) return { skipped: `${file} is tracked in git` };
  const text = existsSync(file) ? read(file) : null;
  const clean = text === null ? '' : strip(text);
  const taken = HOOKS.find((h) => new RegExp(`^${h}\\s*:`, 'm').test(clean));
  if (taken) return { skipped: `${file} already defines ${taken}` };
  const block = HOOKS.flatMap((h) => [`${h}: ${MARK}`, `  commands: ${MARK}`, `    eocrm: ${MARK}`, `      run: ${yamlQuoted(hookCommand(h, opts, '{0}'))} ${MARK}`]);
  write(file, withLines(clean, [...(text === null || text.includes(CREATED) ? [CREATED] : []), ...block]));
  if (!git(cwd, ['check-ignore', '--', file])) {
    const exclude = excludeOf(cwd);
    mkdirSync(resolve(exclude, '..'), { recursive: true });
    const before = existsSync(exclude) ? read(exclude) : '';
    appendFileSync(exclude, `${before && !before.endsWith('\n') ? '\n' : ''}${excludeLines(root, file)}`, 'latin1');
  }
  return { file };
}

function uninstallLefthook(cwd, root) {
  const file = lefthookLocal(root);
  if (!file || !existsSync(file)) return false;
  const text = read(file);
  const clean = strip(text);
  if (clean === text) return false;
  if (text.includes(CREATED) && !clean.trim()) unlinkSync(file);
  else write(file, clean);
  const exclude = excludeOf(cwd);
  if (existsSync(exclude)) write(exclude, read(exclude).replace(excludeLines(root, file), ''));
  return true;
}

export function install(cwd, opts) {
  const dir = hooksDir(cwd);
  mkdirSync(dir, { recursive: true });
  const done = [];
  const skipped = [];
  for (const name of HOOKS) {
    const file = join(dir, name);
    const line = hookLine(name, opts);
    const text = existsSync(file) ? read(file) : null;
    if (text === null) {
      write(file, `${SHEBANG}${CREATED}\n${line}\n`, { mode: 0o755 });
      done.push(name);
      continue;
    }
    const why = text.includes(CREATED) ? null : refusal(cwd, file, text);
    if (why) {
      skipped.push(`${name}: ${why}`);
      continue;
    }
    write(file, withLines(strip(text), [...(text.includes(CREATED) ? [CREATED] : []), line]));
    done.push(name);
  }
  const lefthook = installLefthook(cwd, worktreeOf(cwd).root, opts);
  if (lefthook?.skipped) skipped.push(`lefthook-local: ${lefthook.skipped}`);
  return { dir, done, skipped, lefthook: lefthook?.file ?? null };
}

// Removes only our lines; a file eocrm created goes only when nothing else was added to it.
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
    const clean = strip(text);
    if (clean === text) continue;
    if (text.includes(CREATED) && clean === SHEBANG) unlinkSync(file);
    else write(file, clean);
    removed.push(name);
  }
  if (uninstallLefthook(cwd, worktreeOf(cwd).root)) removed.push('lefthook-local');
  return { dir, removed };
}

export function installed(cwd) {
  try {
    const dir = hooksDir(cwd);
    const local = lefthookLocal(worktreeOf(cwd).root);
    const block = local && existsSync(local) ? read(local) : '';
    return HOOKS.filter((n) => (existsSync(join(dir, n)) && read(join(dir, n)).includes(MARK)) || block.includes(`\n${n}: ${MARK}`) || block.startsWith(`${n}: ${MARK}`));
  } catch {
    return [];
  }
}

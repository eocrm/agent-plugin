import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export function dataDir({ argv, env, data, fallback }) {
  const eq = argv.find((a) => a.startsWith('--data='));
  const i = argv.indexOf('--data');
  const dir = data || (eq && eq.slice(7)) || (i >= 0 && argv[i + 1]) || env.CLAUDE_PLUGIN_DATA || env.PLUGIN_DATA || fallback;
  if (!dir) throw new Error('eocrm: no data dir');
  mkdirSync(dir, { recursive: true });
  if (process.platform !== 'win32') {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // not ours or read-only: use it as it is
    }
  }
  return dir;
}

export function parseArgs(argv) {
  const hi = argv.indexOf('--harness');
  const harness = hi >= 0 && argv[hi + 1] === 'codex' ? 'codex' : 'claude';
  const event = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--data' && argv[i - 1] !== '--harness');
  return { event, harness };
}

const codexHome = (env) => resolve(env.CODEX_HOME || join(homedir(), '.codex'));

export const codexData = (env) => join(codexHome(env), 'plugins', 'data', 'eocrm-eocrm');

export function cliHarness({ flag, env, script }) {
  if (flag) return flag === 'codex' ? 'codex' : 'claude';
  if (env.CLAUDE_PLUGIN_ROOT || env.CLAUDE_PLUGIN_DATA) return 'claude';
  if (env.PLUGIN_ROOT || env.PLUGIN_DATA) return 'codex';
  return resolve(script).startsWith(join(codexHome(env), 'plugins') + sep) ? 'codex' : 'claude';
}

import { chmodSync, mkdirSync } from 'node:fs';

export function dataDir({ argv, env, data }) {
  const eq = argv.find((a) => a.startsWith('--data='));
  const i = argv.indexOf('--data');
  const dir = data || (eq && eq.slice(7)) || (i >= 0 && argv[i + 1]) || env.CLAUDE_PLUGIN_DATA;
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

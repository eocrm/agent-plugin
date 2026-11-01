import { mkdirSync } from 'node:fs';

export function dataDir({ argv, env }) {
  const i = argv.indexOf('--data');
  const dir = i >= 0 && argv[i + 1] ? argv[i + 1] : env.CLAUDE_PLUGIN_DATA;
  if (!dir) throw new Error('eocrm: no data dir');
  mkdirSync(dir, { recursive: true });
  return dir;
}

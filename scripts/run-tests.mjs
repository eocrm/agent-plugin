import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const [dir, flag] = process.argv.slice(2);
let files = [];
try {
  files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).map((f) => `${dir}/${f}`);
} catch (e) {
  if (flag !== '--optional' || e.code !== 'ENOENT') throw e;
}
if (!files.length && flag === '--optional') {
  console.log('no budget tests yet');
  process.exit(0);
}
process.exit(spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' }).status ?? 1);

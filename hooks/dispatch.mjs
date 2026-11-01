import { dataDir } from '../lib/paths.mjs';
import { handle, logError, runClient } from '../lib/run.mjs';
import { flush } from '../lib/flush.mjs';
import { gitTimeout } from '../lib/state.mjs';

const HOOK_GIT_MS = 1000;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const argv = process.argv.slice(2);
  let data;
  try {
    data = dataDir({ argv, env: process.env });
    const ctx = { data, env: process.env, now: Date.now };
    if (argv[0] === 'flush') {
      await flush({ data, clientFor: runClient(ctx) });
      return;
    }
    gitTimeout.ms = HOOK_GIT_MS;
    const { stdout } = await handle(argv[0], JSON.parse(await readStdin()), ctx);
    if (stdout) process.stdout.write(stdout);
  } catch (e) {
    if (data) logError(data, e);
  }
}

main().finally(() => {
  process.exitCode = 0;
});

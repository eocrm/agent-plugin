import { dataDir, parseArgs } from '../lib/paths.mjs';
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
    const { event, harness } = parseArgs(argv);
    const ctx = { data, env: process.env, now: Date.now, harness };
    if (event === 'flush') {
      await flush({ data, clientFor: runClient(ctx) });
      return;
    }
    gitTimeout.ms = HOOK_GIT_MS;
    const { stdout } = await handle(event, JSON.parse(await readStdin()), ctx);
    if (stdout) await new Promise((resolve) => process.stdout.write(stdout, resolve));
  } catch (e) {
    if (data) logError(data, e);
  }
}

// Exits at once: a request the reconciler gave up on must not keep the hook past its timeout.
main().finally(() => process.exit(0));

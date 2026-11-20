#!/usr/bin/env node
import { main } from './eocrm.mjs';

// A hook exits as soon as it is done or out of time: nothing it left pending may hold git.
main({ harness: 'cli' }).then((code) => {
  if (process.argv[2] === 'hook') process.exit(code);
  process.exitCode = code;
});

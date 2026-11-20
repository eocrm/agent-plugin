#!/usr/bin/env node
import { main } from './eocrm.mjs';

main({ harness: 'cli' }).then((code) => {
  process.exitCode = code;
});

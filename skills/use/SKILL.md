---
name: use
description: Choose the eocrm workspace for this repository
argument-hint: "[--here] <workspace> | --accept | --decline"
---
Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/eocrm.mjs" use --data "${CLAUDE_PLUGIN_DATA}" <args>`, where `<args>` is what the member gave: `[--here] <workspace>`, `--accept` or `--decline`. Report its output. `--here` sets only this worktree. If it says `run /eocrm:login`, offer that.

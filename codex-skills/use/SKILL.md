---
name: use
description: Choose the eocrm workspace for this repository
argument-hint: "[--here] <workspace> | --accept | --decline"
---
`<root>` is the eocrm plugin folder: this file's path without `/codex-skills/use/SKILL.md`.

Run `node "<root>/scripts/eocrm.mjs" use <args>`, where `<args>` is what the member gave: `[--here] <workspace>`, `--accept` or `--decline`. Report its output. `--here` sets only this worktree. If it says `run /eocrm:login`, offer that.

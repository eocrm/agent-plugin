---
name: login
description: Sign in to eocrm and pair with your agent connection
argument-hint: "[workspace]"
disable-model-invocation: true
---
`<root>` is the eocrm plugin folder: this file's path without `/codex-skills/login/SKILL.md`.

Run, adding the workspace slug if the member gave one:

`node "<root>/scripts/eocrm.mjs" login --harness codex [<workspace>]`

- `node` missing or `needs Node 20+`: tell the member eocrm needs Node 20+ on PATH.
- `workspace required`: show the `workspace` lines, ask for the slug, run again with it.
- `choose a connection`: show the labels, then run the same script with `pair --harness codex <id>` for the member's pick.
- `pairing requested`: tell the member to approve in Account → Agents within 15 minutes.
- `.claude/eocrm.json names`: ask the member, then run the use skill with `--accept` or `--decline`.

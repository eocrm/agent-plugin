---
description: Sign in to eocrm and pair with your Claude Code connection
argument-hint: "[--region eu|ru] [workspace]"
---
Ask for the region (eu or ru) if $ARGUMENTS lacks one, then run:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/eocrm.mjs" login --data "${CLAUDE_PLUGIN_DATA}" --region <region> [<workspace>]`

- `node` missing or `needs Node 20+`: tell the member eocrm needs Node 20+ on PATH.
- `workspace required`: show the `workspace` lines, ask for the slug, run again with it.
- `choose a connection`: show the labels, then run the same script with `pair --data "${CLAUDE_PLUGIN_DATA}" <id>` for the member's pick.
- `pairing requested`: tell the member to approve in Account → Agents within 15 minutes.
- `.claude/eocrm.json names`: ask the member, then run `/eocrm:use --accept` or `--decline`.

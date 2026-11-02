---
name: link-run
description: Link this worktree's eocrm run to a task, or to none. Use when asked which task this work belongs to, or when told to use the eocrm link-run skill.
---
Ask the member which task this worktree is for, if not already said. Then run:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/eocrm.mjs" link <KEY|none> --data "${CLAUDE_PLUGIN_DATA}"`

`KEY` is the task key, like `ABC-12`. Use `none` when the work belongs to no task. Report the output. Ask once per worktree; the answer is remembered.

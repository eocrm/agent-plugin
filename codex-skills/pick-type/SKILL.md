---
name: pick-type
description: Choose the eocrm task type (epic, subtask, bug) when creating tasks for agent work.
---
`<root>` is the eocrm plugin folder: this file's path without `/codex-skills/pick-type/SKILL.md`.

Read the Conventions types: `node "<root>/scripts/eocrm.mjs" conventions --harness codex`. Pass its `workspace` as `tenant` on eocrm MCP calls.

Use `epic_type` for a slice of work, `subtask_type` for one pull request under an epic, `bug_type` for a defect. If the type you need is null, rerun the command above with `--refresh` once. If it is still null, or the command fails, ask the member which type; never guess. Offer to save the answer to Conventions (needs "Let AI assistants change configuration").

Create with the type key: `tasks_create` with `type: "bug"` (the key from `bug_type.key`). If an older server refuses `type`, look the type up with `records_search` on `task_type`. Checklists are `task_checklist_item` records.

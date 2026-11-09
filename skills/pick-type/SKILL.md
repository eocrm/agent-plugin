---
name: pick-type
description: Choose the eocrm task type (epic, subtask, bug) when creating tasks for agent work.
---
Read the Conventions types: `node "${CLAUDE_PLUGIN_ROOT}/scripts/eocrm.mjs" conventions --session "${CLAUDE_SESSION_ID}" --data "${CLAUDE_PLUGIN_DATA}"`. Pass its `workspace` as `tenant` on eocrm MCP calls.

Use `epic_type` for a slice of work, `subtask_type` for one pull request under an epic, `bug_type` for a defect. If the type you need is null, rerun the command above with `--refresh` once. If it is still null, or the command fails, ask the member which type; never guess. Offer to save the answer to Conventions (needs "Let AI assistants change configuration").

Create with the type key: `tasks_create` with `type: "bug"` (the key from `bug_type.key`). If an older server refuses `type`, look it up via `records_search` on `task_type`. Checklists are `task_checklist_item` records.

Before `tasks_create`: `priority_id` from `records_search` on `task_priority` (once per session). Urgent = prod broken or data at risk; High = blocks work or user-visible defect; Normal = planned; Low = nice-to-have. Unset only if unjudgeable; say why. `component_ids` from `task_component` (has descriptions); none if none fits.

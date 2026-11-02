---
name: pick-type
description: Choose the eocrm task type (epic, subtask, bug) when creating tasks for agent work.
---
Read the Conventions types: `node "${CLAUDE_PLUGIN_ROOT}/scripts/eocrm.mjs" conventions --session "${CLAUDE_SESSION_ID}" --data "${CLAUDE_PLUGIN_DATA}"`. Pass its `workspace` as `tenant` on eocrm MCP calls.

Use `epic_type` for a slice of work, `subtask_type` for one pull request under an epic, `bug_type` for a defect. If it fails, or the type you need is missing or null, ask the member; never guess a type.

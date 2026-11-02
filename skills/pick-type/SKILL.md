---
name: pick-type
description: Choose the eocrm task type (epic, subtask, bug) when creating tasks for agent work.
---
Read the Conventions types: `node "${CLAUDE_PLUGIN_ROOT}/scripts/eocrm.mjs" conventions --data "${CLAUDE_PLUGIN_DATA}"`.

Use `epic_type` for a slice of work, `subtask_type` for one pull request under an epic, `bug_type` for a defect. If the type you need is null, ask the member; never guess a type.

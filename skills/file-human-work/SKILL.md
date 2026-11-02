---
name: file-human-work
description: File work only a person can do (approval, credentials, a manual step) as a task in eocrm that blocks the agent's task.
---
1. Read the conventions: `node "${CLAUDE_PLUGIN_ROOT}/scripts/eocrm.mjs" conventions --session "${CLAUDE_SESSION_ID}" --data "${CLAUDE_PLUGIN_DATA}"`. If it fails, or `human_space` is missing or null, ask the member where such tasks go; never guess.
2. Pass the output's `workspace` as `tenant` on every eocrm MCP call.
3. Create the task in `human_space` with the MCP tasks tool: a clear title saying what the member must do.
4. Link it: `records_create` entity `association`, `source_type: task` (the human task), `source_id` its id, `target_type: task`, `target_id` the agent's task. Look up the "blocks" key in the `association_relation` entity for `relation_type`; never guess it. If this run has no task, ask the member which task it blocks, or file it unlinked.
5. Tell the member what was filed, then continue with other work.

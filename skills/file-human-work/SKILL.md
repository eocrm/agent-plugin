---
name: file-human-work
description: File work only a person can do (approval, credentials, a manual step) as a task in eocrm that blocks the agent's task.
---
1. Read the conventions: `node "${CLAUDE_PLUGIN_ROOT}/scripts/eocrm.mjs" conventions --data "${CLAUDE_PLUGIN_DATA}"`.
2. If `human_space` is null, ask the member where such tasks go; never guess.
3. With the eocrm MCP tasks tool, create the task in `human_space`: a clear title saying what the member must do, blocked by nothing, blocking the agent's task.
4. Tell the member what was filed, then continue with other work.

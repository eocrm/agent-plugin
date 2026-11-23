---
name: attach
description: Attach files (screenshots, logs, documents) to the linked eocrm task or another record. Use when the member asks to attach or upload files to eocrm.
---
`<root>` is the eocrm plugin folder: this file's path without `/codex-skills/attach/SKILL.md`.

1. Find the task: the eocrm reminder names the linked key (`this run is linked to KEY`); if there is none, ask the member. Get its id with the MCP `tasks_get` tool.
2. Upload: `node "<root>/scripts/eocrm.mjs" upload <file>... --to task:<id> --json --harness codex`. For any other entity use `--to <entity_type>:<id>`. Each result has `id` and `rich_text`, or `error`.
3. If that cannot run, or is refused for sign-in or scope, use MCP `records_action` on entity `file`: `upload_start`, the curl command it returns, then `upload_finish`.
4. Only when the member asked, or the context makes it obvious, put the `rich_text` snippets into the task: append them to its description with `tasks_update`, or post a comment with `records_create` entity `comment`.
5. Report what was attached; show any `error` as it is.

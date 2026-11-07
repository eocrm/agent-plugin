---
name: record-judgement
description: Record a ruling, a review finding or a split in the eocrm run. Use only for those; nothing else.
---
`<root>` is the eocrm plugin folder: this file's path without `/codex-skills/record-judgement/SKILL.md`.

Rulings, review findings and splits only. Not commands, commits or chatter.

- Ruling: `node "<root>/scripts/eocrm.mjs" record ruling --what '<decision>' --why '<reason>' [--cost-if-wrong '<cost>']`
- Finding: `node "<root>/scripts/eocrm.mjs" record finding --severity critical|important|minor|theoretical --summary '<text>' [--outcome open|fixed|accepted|disputed|dropped]`

Keep your text in single quotes; write a `'` inside it as `'\''`. Record a finding again with its new `--outcome` when it changes. A split is a ruling saying what was split and why. Keep text short; secrets are redacted. If it exits non-zero, tell the member it was not recorded.

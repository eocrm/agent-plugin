---
name: record-judgement
description: Record a ruling, a review finding or a split in the eocrm run. Use only for those; nothing else.
---
Rulings, review findings and splits only. Not commands, commits or chatter.

- Ruling: `node "${CLAUDE_PLUGIN_ROOT}/scripts/eocrm.mjs" record ruling --what "<decision>" --why "<reason>" [--cost-if-wrong "<cost>"] --data "${CLAUDE_PLUGIN_DATA}"`
- Finding: `node "${CLAUDE_PLUGIN_ROOT}/scripts/eocrm.mjs" record finding --severity critical|important|minor|theoretical --summary "<text>" [--outcome open|fixed|accepted|disputed|dropped] --data "${CLAUDE_PLUGIN_DATA}"`

Repeat a finding with a new `--outcome` to update it. A split is a ruling saying what was split and why. Keep text short; secrets are redacted.

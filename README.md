# eocrm Claude Code plugins

Two plugins in one catalogue:

- **`eocrm-mcp`**: eocrm tools only. Claude can read and change tasks, contacts, deals, appointments and records in your workspaces through the eocrm MCP server. No hooks and no tracking.
- **`eocrm`**: agent work. It reports Claude Code runs, plan steps, commits, test runs, PRs and review findings to your eocrm workspace. It installs `eocrm-mcp` too.

## Install

```
/plugin marketplace add eocrm/claude-plugin
/plugin install eocrm-mcp@eocrm     # tools only
/plugin install eocrm@eocrm         # agent work (includes the tools)
```

For the tools, run `/mcp`, select `plugin:eocrm-mcp:eocrm` and sign in through the browser. For agent work, also run `/eocrm:login`. If you added the eocrm MCP server by hand before, remove it (`claude mcp remove eocrm`) so the tools aren't listed twice.

Then turn on updates: `/plugin` → Marketplaces → `eocrm` → Enable auto-update. Claude Code leaves it off for third-party catalogues, and you only receive a release when its `version` changes.

Prerequisites for `eocrm` (agent work): Node 20+ on PATH, `git`, optionally `gh`. Without a GitHub SSH key, set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` so installs and updates clone over HTTPS.

## Use

- `/eocrm:login` signs in through the browser (sign-in starts in the EU and eocrm resolves your home region; `--region ru` signs in to an RU workspace) and stores tokens in the OS keychain, or a 0600 file when no keychain is usable.
- `/eocrm:use` maps the current repo to a workspace. The mapping is stored per repo, and `.claude/eocrm.json` (workspace slug and region only) can be committed to share it; each user confirms it once. With a single workspace the plugin picks it automatically.
- Reminders: on session start, resume or `/clear`, on a new branch, or when work moves to another task, the plugin reminds Claude of the linked task. The Conventions **Task switch check** sets how often it checks for a task switch: Every prompt, After a pause (the default), or Signals only.
- Four skills: `pick-type`, `link-run`, `record-judgement`, `file-human-work`.

## What is sent

Run metadata (branch, repo, task key), plan items, commits (sha, subject), test commands and result lines, PR links and review findings. Everything is scrubbed for secrets and capped in length before it leaves the machine. Events are queued locally and retried; when the queue cannot be flushed the run shows as "tracking stale".

Token counts per model are read from the local session transcript and its subagent transcripts; nothing else from them leaves the machine.

## Troubleshooting

Run `/eocrm:status` for sign-in, workspace and pairing state.

## Trust boundary

Environment a repo injects into hooks (`NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, proxy variables) is outside what the plugin can defend. It relies on Claude Code's workspace trust: only trust repos you trust.

## Releasing

Users get a release only when `version` in `.claude-plugin/plugin.json` changes: bump it (and `package.json`) in the release PR. Before a release run `claude plugin validate --strict .` locally (no model call) and put its result line in the PR.

## Nightly smoke (setup)

`.github/workflows/nightly-smoke.yml` runs a REST-only round trip; it never runs `claude`. Without credentials it warns and passes.

- Secrets: `EOCRM_SMOKE_REGION`, `EOCRM_SMOKE_CLIENT_ID`, `EOCRM_SMOKE_REFRESH_TOKEN`, `SMOKE_SECRETS_PAT` (secrets write; stores the rotated refresh token).
- Variables: `EOCRM_SMOKE_WORKSPACE`, `EOCRM_SMOKE_TASK`.
- Runs never overlap (one `concurrency` group): each spends the stored refresh token once.
- Seed (and re-seed when the store step fails): sign the smoke member in with a separate `--data` dir so your own sign-in is untouched (`node scripts/eocrm.mjs login --data <dir> --region eu test`), then `node scripts/eocrm.mjs smoke-seed --data <dir> --repo <owner>/<repo>`. It writes the region, client id, refresh token and workspace through `gh` (stdin, never printed) and signs that data dir out, so the token family belongs to CI. Set `EOCRM_SMOKE_TASK` and `SMOKE_SECRETS_PAT` by hand.

## License

Apache-2.0. "eocrm" is a trademark of eocrm; the license grants no right to use it.

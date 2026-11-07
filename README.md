# eocrm plugins for Claude Code and Codex

Two plugins in one catalogue, for Claude Code and for Codex:

- **`eocrm-mcp`**: eocrm tools only. Claude can read and change tasks, contacts, deals, appointments and records in your workspaces through the eocrm MCP server. No hooks and no tracking.
- **`eocrm`**: agent work. It reports Claude Code and Codex runs, plan steps, commits, test runs, PRs and review findings to your eocrm workspace. It installs `eocrm-mcp` too.

## Install (Claude Code)

```
/plugin marketplace add eocrm/agent-plugin
/plugin install eocrm-mcp@eocrm     # tools only
/plugin install eocrm@eocrm         # agent work (includes the tools)
```

For the tools, run `/mcp`, select `plugin:eocrm-mcp:eocrm` and sign in through the browser. For agent work, also run `/eocrm:login`. If you added the eocrm MCP server by hand before, remove it (`claude mcp remove eocrm`) so the tools aren't listed twice.

Then turn on updates: `/plugin` → Marketplaces → `eocrm` → Enable auto-update. Claude Code leaves it off for third-party catalogues, and you only receive a release when its `version` changes.

## Install (Codex)

```
codex plugin marketplace add eocrm/agent-plugin
codex plugin add eocrm@eocrm         # agent work
codex plugin add eocrm-mcp@eocrm     # tools
```

Then open `/hooks` in Codex and trust the eocrm hooks (Codex runs none until you do; `status` says so while no hook has run in the repo), and sign in with the `login` skill. Node 20+ must be on the PATH of the Codex desktop app too.

Prerequisites for `eocrm` (agent work): Node 20+ on PATH, `git`, optionally `gh`. Without a GitHub SSH key, set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` so installs and updates clone over HTTPS.

## Use

- `/eocrm:login` (a skill; in Codex, ask for the `login` skill) signs in through the browser (sign-in starts in the EU and eocrm resolves your home region; `--region ru` signs in to an RU workspace) and stores tokens in the OS keychain, or a 0600 file when no keychain is usable.
- `/eocrm:use` maps the current repo to a workspace. The mapping is stored per repo, and `.claude/eocrm.json` (workspace slug and region only) can be committed to share it; each user confirms it once. With a single workspace the plugin picks it automatically.
- Reminders: on session start, resume or `/clear`, on a new branch, or when work moves to another task, the plugin reminds Claude of the linked task. The Conventions **Task switch check** sets how often it checks for a task switch: Every prompt, After a pause (the default), or Signals only.
- Four skills: `pick-type`, `link-run`, `record-judgement`, `file-human-work`.
- `/eocrm:status` (Codex: the `status` skill) shows sign-in, workspace and pairing.

## Pair with your tools connection

The plugin's sign-in can only report and read runs; it can't change tasks. If your tools (`eocrm-mcp`) are already signed in, the plugin's sign-in sends a pairing request: in eocrm open Account → Agents and select **Approve**, so both show as one agent. If you signed in the tools afterwards, select **Merge into…** on the new connection there instead. Claude Code pairs with Claude Code, Codex with Codex; a request expires after 15 minutes. Someone who uses both signs in twice and sees two agents.

Agent work must be on in the workspace (Settings → Modules); it needs Tasks and AI assistants. What runs show, the conventions and alerts: [Agent work help](https://docs.eocrm.io/help/agent-work/).

## Messages from eocrm

eocrm can answer tracking calls with short messages, and the plugin shows each one once, at your next prompt, Bash or task tool call, or stop. Lines meant for you (someone commented on the linked task, conventions changed, a plugin update) appear in the terminal and cost Claude no tokens. A comment you wrote on the linked task yourself is passed to Claude, quoted as your words rather than instructions. An update notice shows at most once a day. If the plugin is older than eocrm's minimum, tracking pauses and keeps its queue until you run `/plugin marketplace update eocrm`. You're also told once per session when Agent work is off for the workspace or you're signed out.

## What is sent

Run metadata (branch, repo, task key), plan items, commits (sha, subject), test commands and result lines, PR links, review findings, and turn boundaries and waiting (for permission or for you; Claude Code also for a question). Never your prompts, the assistant's replies or file contents. Everything is scrubbed for secrets and capped in length before it leaves the machine. Events are queued locally and retried; when the queue cannot be flushed the run shows as "tracking stale".

Token counts per model: Claude Code's come from the local session transcript and its subagent transcripts; Codex's come from Codex itself (its per-request hook), with no transcript read. Nothing else from either leaves the machine.

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

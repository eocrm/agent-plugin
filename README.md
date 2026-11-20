# eocrm plugins for Claude Code and Codex

Two plugins in one catalogue, for Claude Code and for Codex:

- **`eocrm-mcp`**: eocrm tools only. Claude can read and change tasks, contacts, deals, appointments and records in your workspaces through the eocrm MCP server. No hooks and no tracking.
- **`eocrm`**: agent work. It reports Claude Code and Codex runs, plan steps, commits, test runs, PRs and review findings to your eocrm workspace. In Claude Code it installs `eocrm-mcp` too; in Codex, add `eocrm-mcp` yourself.

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

Then open `/hooks` in Codex and trust the eocrm hooks, listed under `eocrm: …` names (Codex runs none until you do, and asks again after an update changes them; `status` says so while no hook has run in the repo), and sign in with the `login` skill. Node 20+ must be on the PATH of the Codex desktop app too. Codex uses its own skill texts (`codex-skills/`), which find the plugin's data and session without Claude Code's variables.

Prerequisites for `eocrm` (agent work): Node 20+ on PATH, `git`, optionally `gh`. Without a GitHub SSH key, set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` so installs and updates clone over HTTPS.

## Use

- `/eocrm:login` (a skill; in Codex, ask for the `login` skill) signs in through the browser (sign-in starts in the EU and eocrm resolves your home region; `--region ru` signs in to an RU workspace) and stores tokens in the OS keychain, or a 0600 file when no keychain is usable.
- `/eocrm:use` maps the current repo to a workspace. The mapping is stored per repo, and `.claude/eocrm.json` (workspace slug and region only) can be committed to share it; each user confirms it once. With a single workspace the plugin picks it automatically.
- Reminders: on session start, resume or `/clear`, on a new branch, or when work moves to another task, the plugin reminds Claude of the linked task. The Conventions **Task switch check** sets how often it checks for a task switch: Every prompt, After a pause (the default), or Signals only.
- Four skills: `pick-type`, `link-run`, `record-judgement`, `file-human-work`.
- `/eocrm:status` (Codex: the `status` skill) shows sign-in, workspace and pairing.

## Use with any agent (CLI)

For agents without the plugin, the `@eocrm/cli` package reports their runs and commits through git hooks. Node 20+ and `git` are required; `gh` is optional (the branch's pull request).

```
npx @eocrm/cli init                    # in the repo
npx @eocrm/cli init --agent cursor     # also set the repo's default agent
```

`--agent` is one of `claude_code`, `cursor`, `codex`, `cline`, `roo`, `opencode`, `aider`, or `none` to clear it. `init` signs in if needed, maps the repo to a workspace (`eocrm init <workspace>` names one), copies the CLI to `<data>/bin/<version>` with a launcher at `<data>/bin/eocrm.mjs` (so hooks survive npx clearing its cache), and adds one line to the repo's `post-commit`, `pre-push` and `post-checkout` hooks. Data lives in `$XDG_DATA_HOME/eocrm`, `~/.local/share/eocrm`, or `%APPDATA%\eocrm`; only `--data <dir>` overrides it. The CLI keeps its own sign-in and never touches the plugin's.

### Per tool

A commit counts for an agent when it carries that agent's signal; with none, it counts for the repo's `--agent`; with neither it is a person's commit and starts no run.

| Tool | Detected automatically | Needs `--agent` |
|---|---|---|
| Cline (VS Code) | commits from its terminal (`CLINE_ACTIVE`) | commits made through other means |
| Roo Code (VS Code) | commits from its terminal (`ROO_ACTIVE`) | commits made through other means |
| Cursor | the Cursor agent's terminal (`CURSOR_AGENT`, or the agent terminal role) | a person's terminal in Cursor looks the same as any editor terminal: set `--agent cursor` only if all commits there are the agent's |
| opencode | its shell (`OPENCODE=1`) | no |
| Aider | the ` (aider)` author or committer suffix, or a `Co-authored-by: aider` trailer (aider's defaults) | if you turned attribution off |
| Claude Code, Codex | their shell variables | prefer the plugin; with the plugin live in the worktree the CLI hooks stay quiet |

Attribution is display only, not a trust boundary.

### Sign in

`eocrm login [workspace]` opens the browser; `eocrm login --device [workspace]` prints a code to approve on another device (SSH, containers). `--region ru` signs in to an RU workspace. `eocrm logout` signs out. Tokens go to the OS keychain, or a 0600 file when none is usable. Login, `init` and `status` print `Signed in at <sign-in host> — reporting to <workspace>`; check the workspace there, since anyone who sees a `--device` code can answer it first (the server gives the CLI no account name).

### Commands

| Command | Does |
|---|---|
| `eocrm init [workspace] [--agent X] [--shared-hooks]` | sign in if needed, map the repo, install the hooks |
| `eocrm status` | sign-in, workspace, agent, hooks and live runs |
| `eocrm sync` | send queued events, import plans, check the branch's PR |
| `eocrm run start [--agent X]` / `run stop` | start or end a run by hand (a started run carries its agent to commits without a signal) |
| `eocrm link <KEY\|none>` | link this worktree to a task |
| `eocrm link <change> <KEY\|none>` | link an OpenSpec change to a task |
| `eocrm openspec import --space KEY` | create tasks for unlinked OpenSpec changes |
| `eocrm uninstall` | remove exactly the lines `init` added |

### Hooks

Hooks only queue an event and return; a detached process sends it. They never fail or noticeably slow `git commit` or `git push`, and always exit 0. `init` inserts its line into an existing husky, lefthook or `core.hooksPath` hook (or a hand-written sh hook) and keeps the rest byte for byte; `uninstall` restores it. Husky regenerates its hooks on install, which drops the line: re-run `eocrm init` afterwards. If `core.hooksPath` comes from your global or system git config, the hooks directory is shared by other repositories, so `init` refuses unless you pass `--shared-hooks`; the line stays quiet in repos where `init` never ran. Hooks that are not shell scripts are skipped and reported.

### OpenSpec

With `openspec/changes/<id>/tasks.md` in the repo, each open change becomes a plan on a task. `eocrm openspec import --space KEY` creates a task per unlinked change (title from `proposal.md`, the Why section as description) and records the mapping per repo; without `--space` it lists your spaces. To link a change to an existing task use `eocrm link <change> <KEY>`, or put `<!-- eocrm: KEY -->` in its `proposal.md`. Checked-off items in `tasks.md` mark plan items done; lines inside code fences are ignored.

### Upgrading

```
npx @eocrm/cli@latest init
```

This copies the new version and repoints the hooks; `status` warns when the hooks' copy is missing or the CLI is below eocrm's minimum.

### Privacy

The CLI sends the same metadata as the plugin (see "What is sent"): branch, repo, task key, plan items, commit sha and subject, PR links, run boundaries; never prompts, replies or file contents, scrubbed for secrets. OpenSpec import sends titles, the Why text and plan items; OpenSpec import identifies the repo by a hash; run and PR events carry the repository's owner/name, never its remote URL.

## Pair with your tools connection

The plugin's sign-in can only report and read runs; it can't change tasks. If your tools (`eocrm-mcp`) are already signed in, the plugin's sign-in sends a pairing request: in eocrm open Account → Agents and select **Approve**, so both show as one agent. If you signed in the tools afterwards, select **Merge into…** on the new connection there instead. Claude Code pairs with Claude Code, Codex with Codex; a request expires after 15 minutes. Someone who uses both signs in twice and sees two agents.

Agent work must be on in the workspace (Settings → Modules); it needs Tasks and AI assistants. What runs show, the conventions and alerts: [Agent work help](https://docs.eocrm.io/help/agent-work/).

## Messages from eocrm

eocrm can answer tracking calls with short messages, and the plugin shows each one once, at your next prompt, Bash or task tool call, or stop. Lines meant for you (someone commented on the linked task, conventions changed, a plugin update) appear in the terminal and cost the agent no tokens. A comment you wrote on the linked task yourself is passed to the agent, quoted as your words rather than instructions. An update notice shows at most once a day. If the plugin is older than eocrm's minimum, tracking pauses and keeps its queue until you update it (`/plugin marketplace update eocrm`; Codex: `codex plugin marketplace upgrade eocrm`). You're also told once per session when Agent work is off for the workspace or you're signed out.

## What is sent

Run metadata (branch, repo, task key), plan items, commits (sha, subject), test commands and result lines (Codex reports no exit code, so its test runs have none), PR links, review findings, and turn boundaries and waiting (for permission or for you; Claude Code also for a question). Never your prompts, the assistant's replies or file contents. Everything is scrubbed for secrets and capped in length before it leaves the machine. Events are queued locally and retried; when the queue cannot be flushed the run shows as "tracking stale".

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

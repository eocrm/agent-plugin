# eocrm Claude Code plugin

Reports Claude Code agent work (runs, plan steps, commits, test runs, PRs, review findings) to your eocrm workspace.

## Install

```
/plugin marketplace add eocrm/claude-plugin
/plugin install eocrm@eocrm
```

The repository is private: you need git access to it. Prerequisites: Node 20+ on PATH, `git`, optionally `gh`.

## Use

- `/eocrm:login` signs in through the browser (region picker) and stores tokens in the OS keychain, or a 0600 file when no keychain is usable.
- `/eocrm:use` maps the current repo to a workspace. The mapping is stored per repo, and `.claude/eocrm.json` (workspace slug and region only) can be committed to share it; each user confirms it once. With a single workspace the plugin picks it automatically.
- Four skills: `pick-type`, `link-run`, `record-judgement`, `file-human-work`.

## What is sent

Run metadata (branch, repo, task key), plan items, commits (sha, subject), test commands and result lines, PR links and review findings. Everything is scrubbed for secrets and capped in length before it leaves the machine. Events are queued locally and retried; when the queue cannot be flushed the run shows as "tracking stale".

## Troubleshooting

Run `/eocrm:status` for sign-in, workspace and pairing state.

## Trust boundary

Environment a repo injects into hooks (`NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, proxy variables) is outside what the plugin can defend. It relies on Claude Code's workspace trust: only trust repos you trust.

## Releasing

Before a release run `claude plugin validate --strict .` locally (no model call) and put its result line in the PR.

## Nightly smoke (setup)

`.github/workflows/nightly-smoke.yml` runs a REST-only round trip; it never runs `claude`. Without credentials it warns and passes.

- Secrets: `EOCRM_SMOKE_REGION`, `EOCRM_SMOKE_CLIENT_ID`, `EOCRM_SMOKE_REFRESH_TOKEN`, `SMOKE_SECRETS_PAT` (secrets write; stores the rotated refresh token).
- Variables: `EOCRM_SMOKE_WORKSPACE`, `EOCRM_SMOKE_TASK`.
- Runs never overlap (one `concurrency` group): each spends the stored refresh token once.
- Re-seed when the store step fails (expired PAT, revoked token family): renew `SMOKE_SECRETS_PAT` if expired, sign the smoke agent in again to get a fresh refresh token, then `gh secret set EOCRM_SMOKE_REFRESH_TOKEN --repo <owner>/<repo>` and paste it.

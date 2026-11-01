# eocrm Claude Code plugin (Agent work slice 3, plugin half) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task by task (repo rule: subagent-driven, no other mode). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code plugin that signs in to eocrm with a runs-only token and reports a session's run, commits, test runs, PRs, plan steps and SDD steps from hooks, at zero model tokens. A reconciler repairs anything the hooks missed, and a Stop gate blocks the turn only on a 4xx rejection.

**Architecture:**
- **Runtime:** plain ESM JavaScript on Node's standard library. There are no runtime dependencies and no build step, so hooks run straight from the plugin cache.
- **Hook dispatch:** every hook calls `node hooks/dispatch.mjs <event>` in exec form. The dispatcher reads the hook JSON on stdin, writes idempotent events to an on-disk outbox, and flushes the outbox to eocrm REST. It prints nothing, except the two documented outputs: SessionStart link context and the Stop block.
- **CLI:** the slash commands and skills drive `scripts/eocrm.mjs`.
- **Tests:** `node --test`, plus a fixture server built from a vendored slice of eocrm's `openapi.json`.

**Tech Stack:** Node ≥ 20 (stdlib `fetch`, `node:test`, `node:http`, `node:crypto`). Dev dependencies only: `eslint` + `@eslint/js` and `ajv` + `ajv-formats`. Each is the latest stable when installed, with an exact version committed in `package-lock.json`.

**Spec:** `/home/dpws/projects/eocrm/docs/superpowers/specs/2026-10-31-agent-work-slice-3-design.md`. eocrm's side is merged as PR A (`docs/superpowers/plans/2026-10-31-agent-work-slice-3-pr-a.md`, contract 0.19.5).

**Repo:** `eocrm/claude-plugin` (private), checked out at `/home/dpws/projects/claude-plugin`.

**Delivery: four PRs.** Each PR is green on its own:
| PR | Tasks | Ships |
|---|---|---|
| 1 Core + sign-in | T1–T6 | scaffold, scrubber, state, credentials, API client + fixture server, `/eocrm:login` + `/eocrm:use` + pairing |
| 2 Tracking hooks + outbox | T7–T9 | outbox/flush, run lifecycle + linking + heartbeat, commit/test/PR/SDD detectors |
| 3 Plans + reconciler + gate | T10–T12 | plan sources, reconciler, Stop gate |
| 4 Skills + proof + release | T13–T15 | skills + judgement CLI, replay contract + budget tests, CI/nightly/marketplace/README |

**Claude Code docs relied on:**
- https://code.claude.com/docs/en/hooks: event names, matchers, stdin fields, exit codes, the Stop `decision`, `async`, exec form, and which events add stdout to context.
- https://code.claude.com/docs/en/plugins-reference: `plugin.json`, standard layout, `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}`, `/plugin:command` namespacing, and why top-level `bin/` is avoided.
- https://code.claude.com/docs/en/plugins/marketplace-reference: `marketplace.json`.

## Rulings on spec gaps (made while planning)

1. **Workspace choice.** An `agent:runs` token cannot list workspaces: `/v1/my/tenants` sits in the `api` group, and `RejectMcpTokens` refuses MCP tokens there. `tenants_list` is MCP-only.
   - `/eocrm:login <workspace>` therefore takes the slug, and the command asks the member for it when it is missing.
   - The slug is checked against `TenantSlug::PATTERN` and verified with `GET /v1/agent-work/conventions`.
   - eocrm follow-up (dpws approved 2026-11-01): a read-only list of the member's workspaces in the region for `agent:runs` tokens, so login can auto-pick a single workspace.
2. **Command names.** Plugin commands are namespaced, so the spec's `/eocrm login` and `/eocrm use` ship as `/eocrm:login` and `/eocrm:use`.
3. **Stop fires at every turn end, not at session end.**
   - The run is finished on `SessionEnd`.
   - `Stop` runs the reconciler and the gate.
   - A lost SessionEnd leaves the run to read Stalled on the server. The next SessionStart for that worktree finishes it.
4. **An ended run cannot reopen** (`409 run_ended`). `client_run_id` is `session_id`, then `session_id.<n>` for each later generation. A resume after an end starts generation n+1.
5. **One plan source per run.** eocrm ticks against the run's latest `plan` event (`TrackingAutomation::latestPlanId`).
   - Precedence: superpowers plan, then markdown checklist, then todo list.
   - A batch never mixes plan sources.
6. **Node is not guaranteed on PATH** with Claude Code's native installer.
   - Node ≥ 20 on PATH is a documented prerequisite.
   - `/eocrm:login` checks it. Hooks use exec form `node`.
   - If `node` is missing, Claude Code shows a non-blocking hook error and the session is unaffected.
7. **Gate classification.** The gate blocks only on `400`, `403` or `422` from a push.
   - `401`: refresh once, then sign out locally. Never blocks.
   - `404`/`409` on a run: roll to a new run generation.
   - `429`, `5xx`, network errors and timeouts: retry later. Never block.
   - It blocks at most once per rejection fingerprint, and never while `stop_hook_active` is set with a fingerprint it has already blocked on.
8. **Superpowers "commit lands".** A Task item is ticked when the SDD ledger has `Task N: complete`, or when every `- [ ]` step under `### Task N` reads `- [x]` in the plan file at `HEAD`.
9. **Event ids** are capped at 64 characters by `events.*.id`. Each id is `<type>:<base64url(sha256(natural key))[0..22]>`.
10. **What eocrm "shows".** The plugin token cannot read checklists. The reconciler therefore diffs against two things:
    - its local acked set;
    - the run's own `GET /v1/agent-runs/{id}/events`, read once at run start or resume.
11. **Keychain.**
    - macOS: `security`, with the secret on stdin through `security -i`.
    - Linux: `secret-tool`, with the secret on stdin.
    - Windows: a DPAPI-protected file through PowerShell, with the secret on stdin.
    - Fallback (WSL with no Secret Service, or a failed tool): `${DATA}/credentials.json` at mode 0600. Login says once that the file fallback is in use.
    - A secret never goes on argv.
12. **Loopback redirect.** One registration with `redirect_uris` `http://127.0.0.1:{53682,53683,53684}/callback`. eocrm's allowlist accepts `http://127.0.0.1:*`. Login binds the first free port.
13. **Nightly smoke credentials.** Passport rotates refresh tokens. The workflow therefore writes the rotated token back with `gh secret set`, using a secrets-write PAT. Both secrets are OPS-2 placeholders.
14. **SDD steps are sent only while an SDD ledger exists for the active plan** (spec 7). The steps:
    - dispatched: `PreToolUse` on `Agent|Task`;
    - reported: `PostToolUse` on `Agent|Task`;
    - reviewed and fix rounds: ledger lines.
15. **`plan_import` off.** The plugin sends no `plan` events and no ticks, so it never pushes a payload eocrm would ignore.

## Global Constraints
- **No model calls (dpws).** No CI job, test or smoke may run a Claude model or spend model tokens.
  - The nightly smoke calls eocrm REST directly with the plugin token. No `claude` CLI session runs anywhere in CI.
  - The budget test replays a recorded session fixture offline.
  - `claude plugin validate --strict .` is a local pre-release step only.
- **Token scope** `agent:runs` only. DCR `client_name` is exactly `Claude Code (eocrm plugin)`, which eocrm resolves to kind `claude_code`. PKCE uses `S256` and `token_endpoint_auth_method` `none`.
- **Secrets.**
  - Hooks never print the token or pass it to the model. No log line, CLI output, error message or outbox entry contains it.
  - Every text field is scrubbed by the JS port of `SecretScrubber` before it is queued.
- **Hooks print nothing.** The only exceptions are SessionStart `hookSpecificOutput.additionalContext` (the link ask) and the Stop `{"decision":"block","reason":…}`.
  - Exit code is always 0.
  - Errors go to `${DATA}/plugin.log`, scrubbed and capped at 256 KiB (rotated once).
- **Never break the session.** Any failure degrades to "tracking stale". Only the Stop gate blocks, and only per Ruling 7.
- **Endpoints, per region** (only `eu` and `ru` exist):
  - issuer `https://id.<region>.eocrm.io`;
  - API `https://{workspace}.<region>.eocrm.io/api`.
  - `EOCRM_ENDPOINTS` (JSON `{issuer, api}` with a `{workspace}` placeholder) overrides both, for dev and tests.
- **Workspace slug:** `/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/`.
- **Task key in branch or worktree:** `/(?<![A-Za-z0-9])[A-Z][A-Z0-9]{1,9}-[0-9]+(?![A-Za-z0-9])/`, the same rule as eocrm `TaskInference`.
- **eocrm limits** (copied from `EventPayload` and the requests):
  - **Batches:** ≤ 100 events per batch.
  - **Event fields:** `id` ≤ 64; `occurred_at` ≤ now+5 min.
  - **`plan` events:** ≤ 200 items; `plan_key` `/^[A-Za-z0-9._:-]{1,100}$/`; item text ≤ 500; `path` relative (no leading `/`, `\`, `~`, drive letter or scheme).
  - **Text limits:** step label 200, commit subject 200, commit repo 200, test command 500, result line 500, finding summary 1000, ruling what 500 / why 1000 / cost_if_wrong 500, PR url 500 (https only).
  - **Start request:** `client_run_id` ≤ 64, `branch` ≤ 255, `worktree` ≤ 500, `repo` ≤ 200.
- **Event types** are exactly `step`, `commit`, `test_run`, `review_finding`, `ruling`, `pull_request`, `usage`, `plan`. Run states are `running`, `finished`, `failed`, `abandoned`.
- **No tenant-specific names** (keys, ids, statuses, dpws) in code, skills or fixtures. Everything comes from Conventions.
- **Platforms:** macOS, Linux, Windows (native and WSL).
  - Paths sent to eocrm are repo-relative with `/`.
  - Files are read CRLF-tolerant.
  - No top-level `bin/` (claude.ai and Cowork refuse such plugins).
- **Budget:** ≤ **2,000** plugin-injected tokens per recorded session. Estimator: `Math.ceil(utf8Bytes / 3)`.
- **Dependency versions:** latest stable at install, exact in the lockfile, never a floating range in a committed manifest.

## Review Focus
1. **The token leaks through an error path.** Examples: a fetch error message containing the `Authorization` header, a thrown refresh response, or `plugin.log`. Expected: the token string appears in no output, log or outbox file. Pinned in T5 and T14.
2. **Malformed stdin, an unwritable data dir, or a missing `git`.** Expected: the hook exits 0 with empty stdout. Pinned in T8.
3. **Two async PostToolUse hooks run at once,** and a stale lock is left by a killed process. Expected: no lost or duplicated outbox lines, and the lock is recovered after 30 s. Pinned in T3 and T7.
4. **A long offline session.** Expected: the outbox stays bounded at 2,000 entries, dropping the oldest. On reconnect the reconciler re-derives commits, plan and PRs. Stop never blocks. Pinned in T7 and T11.
5. **Repo origin `https://user:ghp_…@github.com/o/r.git`, or a Windows `C:\…\plan.md` path.** Expected: repo is sent as `o/r` and path as `docs/superpowers/plans/x.md`. Pinned in T9 and T10.

---

## PR 1 — Core + sign-in

### Task 1: Scaffold, manifest, lint/unit CI
**Files:**
- Create: `package.json`, `eslint.config.js`, `.gitignore`, `.gitattributes` (`* text=auto eol=lf`)
- Create: `.claude-plugin/plugin.json`
- Create: `lib/paths.mjs`
- Create: `.github/workflows/ci.yml`
- Test: `test/unit/manifest.test.mjs`, `test/unit/paths.test.mjs`

**Interfaces:**
- Produces:
  - `dataDir({argv, env}): string`, resolved from `--data <dir>`, else `env.CLAUDE_PLUGIN_DATA`, else a thrown `Error('eocrm: no data dir')`. The directory is created recursively.
  - `package.json` scripts: `lint`, `test` (`node --test test/unit`), `test:contract`, `test:budget`.

- [ ] **Step 1: Write the failing tests.**
  - `manifest.test.mjs`:
    - `plugin.json` has `name === 'eocrm'`, a semver `version`, `description`, `author.name` and `repository`;
    - every hook command in `hooks/hooks.json`, once it exists, uses `command: 'node'` with `args[0]` starting `${CLAUDE_PLUGIN_ROOT}/`;
    - no top-level `bin/` directory exists.
  - `paths.test.mjs`: `--data` beats env, env is used without `--data`, and the call throws when neither is given.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the files.
  - `package.json`: `"type": "module"`, `"engines": {"node": ">=20"}`, no `dependencies`.
  - CI: `npm ci && npm run lint && npm test` on ubuntu (Node 20 and 24), macOS (24) and Windows (24). Model-free.
- [ ] **Step 4: Run** `npm run lint && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `chore: scaffold eocrm plugin`.

### Task 2: Secret scrubber port and field limits
**Files:**
- Create: `lib/scrub.mjs`
- Create: `test/fixtures/scrubber-vectors.json`, generated once from eocrm `apps/api/modules/Tenant/AgentWork/tests/Unit/SecretScrubberTest.php`
- Test: `test/unit/scrub.test.mjs`

**Interfaces:**
- Produces:
  - `scrub(text: string): string`
  - `clean(text: string, limit: number): string`: cut to 4×limit, scrub, then truncate with suffix `'… [truncated]'`.
  - `LIMITS`: the per-type text limits from Global Constraints.

- [ ] **Step 1: Test.** Every vector `{input, expected}` passes `scrub(input) === expected`. The vector file holds all ~117 dataset rows, including the flag modes (`any`, `attached`, `not-url`, `userinfo`, `openssl`) and segment inheritance.
  - `clean('x'.repeat(300), 200)` has length 200 and ends `'… [truncated]'`.
  - `clean('API_KEY=abc', 500) === 'API_KEY=[redacted]'`.
- [ ] **Step 2: Run** `node --test test/unit/scrub.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** a line-by-line port of `SecretScrubber.php`: `PATTERNS`, `FLAGS`, `segments`, `flagsFor`, `redactions`, `flagValue`, `accepts`, `mask`.
  - PHP possessive quantifiers (`++`, `*+`) have no JS equivalent. Use greedy quantifiers, and let the vectors decide equivalence.
  - Work in UTF-16 indexes consistently.
- [ ] **Step 4: Run** the test. Expected: PASS, all vectors.
- [ ] **Step 5: Commit** `feat: client-side secret scrubber`.

### Task 3: State store and lock
**Files:**
- Create: `lib/state.mjs`
- Test: `test/unit/state.test.mjs`

**Interfaces:**
- Produces:
  - `withLock(dir: string, fn: () => Promise<T>): Promise<T>`: an atomic `mkdir` of `${dir}/.lock`, polled every 25 ms. A lock older than 30 s is broken. Gives up after 5 s with `LockTimeout`.
  - `readJson(file, fallback)` and `writeJsonAtomic(file, value)`: write to a temp file, then rename. On Windows, retry the rename 3× on `EPERM`.
  - `worktreeOf(cwd): {root: string, key: string}`.
    - `root` comes from `git rev-parse --show-toplevel`, else `cwd`.
    - `key` is the first 16 hex characters of `sha256(realpath(root))`, lower-cased first on win32.
  - `loadWorktree(data, key)` and `saveWorktree(data, key, patch)`.
    - File: `${data}/worktrees/<key>.json`.
    - Shape: `{root, workspace?, taskKey?: string|null, linkAnswered: boolean, reportedCommits: string[], openPrs: string[]}`.
  - `loadRun(data, sessionId)` and `saveRun(data, sessionId, patch)`.
    - File: `${data}/runs/<sessionId>.json`.
    - Shape: `{sessionId, generation, clientRunId, runId?, workspace, worktreeKey, startedAt, lastHeartbeatAt?, lastReconcileAt?, conventions?, acked: Record<string,true>, rejected: Rejection[], blockedFingerprints: string[], serverEventsRead: boolean}`.
  - `Rejection = {eventId, type, label, status, code?, message}`.

- [ ] **Step 1: Tests.**
  - 20 parallel `withLock` increments of one counter file end at 20.
  - A 31-second-old lock dir is broken.
  - `worktreeOf` returns the same key for two spellings of one path.
  - `saveRun` merges patches.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: on-disk state and lock`.

### Task 4: Credential store
**Files:**
- Create: `lib/credentials.mjs`
- Test: `test/unit/credentials.test.mjs`

**Interfaces:**
- Produces:
  - `credentialStore({data, platform = process.platform, run = spawnWithStdin}): {get(issuer): Promise<Tokens|null>, set(issuer, tokens): Promise<'keychain'|'file'>, del(issuer): Promise<void>}`.
  - `Tokens = {access_token, refresh_token, expires_at, client_id}`.
  - Keychain service name: `eocrm-claude-plugin`. Account: the issuer.

- [ ] **Step 1: Tests** with a fake `run`:
  - On darwin, `set` calls `security -i` and the secret appears only in the stdin argument, never in args.
  - On linux, it calls `secret-tool store --label=eocrm-claude-plugin service eocrm-claude-plugin account <issuer>` with the secret on stdin.
  - On win32, it calls `powershell -NoProfile -NonInteractive -Command -` with a DPAPI script and the secret on stdin, writing `${data}/credentials.dpapi`.
  - A non-zero exit from the tool falls back to `${data}/credentials.json`, mode `0o600` checked on POSIX, and returns `'file'`.
  - `del` removes the keychain entry and the file.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: keychain-backed credential store`.

### Task 5: Endpoints, API client and the OpenAPI fixture server
**Files:**
- Create: `lib/endpoints.mjs`, `lib/api.mjs`
- Create: `scripts/sync-openapi.mjs`, which writes `test/contract/openapi.agent.json`. The snapshot holds only the operations listed below plus the components they reference, with `info.version` `0.19.5`. It is read from a local eocrm checkout path argument, never fetched in CI.
- Create: `test/support/fixture-server.mjs`, `test/contract/responses/*.json` (recorded bodies)
- Test: `test/unit/endpoints.test.mjs`, `test/contract/api.test.mjs`

**Interfaces:**
- Produces:
  - `endpoints({region, env}): {issuer: string, api(workspace): string}`. Throws on an unknown region or on a slug that fails the pattern.
  - `createClient({endpoints, workspace, store, fetch = globalThis.fetch, timeoutMs = 8000}): Client`. Every method returns `{status: number, body: any}`, throws only `NetworkError` (message carries no headers), refreshes once on 401 via `POST {issuer}/oauth/token` (`grant_type=refresh_token`, `client_id`, `refresh_token`), and saves the rotated tokens. The methods:
    - `startRun({client_run_id, task?, branch?, worktree?, repo?})` → `POST /v1/agent-runs`, 201 or 200;
    - `updateRun(id, {task?, step?, state?})` → `PATCH /v1/agent-runs/{id}`;
    - `heartbeat(id)` → `POST /{id}/heartbeat`, 204;
    - `recordEvents(id, events)` → `POST /{id}/events`, `{accepted, duplicates, dropped}`;
    - `listEvents(id, cursor?)` → `GET /{id}/events`, `{items, next_cursor}`;
    - `conventions()` → `GET /v1/agent-work/conventions`;
    - `pairable()` → `GET /v1/agent-runs/pairable`, `{items: [{id, label, created_at}]}`;
    - `pair(connection_id)` → `POST /v1/agent-runs/pair`, 202 `{status: 'pending', approve_url}`.
  - `startFixtureServer({responses?}): Promise<{url, requests: Array<{method, path, workspace, headers, body}>, close()}>`.
    - Serves `/{workspace}/api/v1/...` and `/oauth/{register,authorize,token}`.
    - Validates each request body against the snapshot schema with Ajv2020 and answers `422` on a mismatch.
    - Dedupes events by `(run, id)`, so it reports `duplicates` the way eocrm does.
    - Answers `409 {code: 'run_ended'}` for an update on an ended run.
    - Validates its own responses against the snapshot.

- [ ] **Step 1: Tests.**
  - `endpoints`:
    - `{region: 'eu'}.api('acme') === 'https://acme.eu.eocrm.io/api'`;
    - the issuer is `https://id.eu.eocrm.io`;
    - `'Acme'` and `'a..b'` throw;
    - an `EOCRM_ENDPOINTS` override wins.
  - `api.test.mjs` against the fixture server:
    - each method hits the documented path and method;
    - the bearer header is present;
    - 401 then refresh then retry succeeds, and the store holds the rotated refresh token;
    - a second 401 returns `{status: 401}` without looping;
    - when `fetch` rejects with an error whose message includes the token, the thrown `NetworkError.message` does not contain it.
- [ ] **Step 2: Run** `npm run test:contract`. Expected: FAIL.
- [ ] **Step 3: Implement.** Run `node scripts/sync-openapi.mjs /home/dpws/projects/eocrm` once, then commit the snapshot.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: eocrm API client and contract fixture server`.

### Task 6: `/eocrm:login`, `/eocrm:use`, pairing, and the CLI
**Files:**
- Create: `lib/login.mjs`, `scripts/eocrm.mjs`
- Create: `commands/login.md`, `commands/use.md`
- Test: `test/contract/login.test.mjs`, `test/unit/cli.test.mjs`

**Interfaces:**
- Consumes: T3 state, T4 store, T5 `endpoints`/`createClient`.
- Produces:
  - `login({data, region, workspace, env, openBrowser, timeoutMs = 300000}): Promise<LoginResult>`.
  - `LoginResult = {workspace, storage: 'keychain'|'file', pairing: {status: 'requested', approveUrl}|{status: 'choose', candidates}|{status: 'standalone'}}`.
  - Account file: `${data}/account.json` `{region, clientId, issuer}`. The client registers once per issuer.
  - CLI subcommands (all take `--data`):
    - `eocrm login --region eu|ru <workspace>`
    - `eocrm use <workspace>`
    - `eocrm pair <connection_id>`
    - `eocrm status`
    - `eocrm logout`
  - Exit codes: `0` ok, `2` usage error (missing workspace or region), `3` sign-in failed. Output is one short line per fact. It never contains a token, code, verifier or state.

- [ ] **Step 1: Tests**, with the fixture server as IdP and API and a fake `openBrowser` that GETs the callback with a code.
  - DCR body is `{client_name: 'Claude Code (eocrm plugin)', redirect_uris: [53682, 53683, 53684 callbacks]}`.
  - The authorize URL has `scope=agent:runs`, `code_challenge_method=S256`, and a 43-character challenge equal to `b64url(sha256(verifier))`.
  - A callback with the wrong `state` is refused, and nothing is stored.
  - If port 53682 is busy, login binds 53683.
  - Verification: `GET conventions` 200 → ok; 404 or 403 → exit 3 with "workspace not found or Agent work is off".
  - Pairing branches: 0 candidates → `standalone`; 1 → `pair` called, then `requested` with `approveUrl`; 2 → `choose`, with no pair call; `422 {code: 'pair_target_unavailable'}` → standalone plus a message naming the code.
  - `eocrm use beta` maps the current **repository** to `beta` (dpws, 2026-11-01: a workspace per GitHub repo without switching):
    - key = the normalised `origin` remote (`host/owner/repo`, lower-case, no scheme, no `.git`, ssh and https forms equal); no origin → the repo's main worktree root path;
    - stored in `<data>/repos.json` (plugin data dir, never a file in the repo), so every clone and worktree of that repo resolves the same way;
    - `eocrm use --here beta` writes the current worktree file only, for a one-off override;
    - resolution order: worktree file → repos.json entry → the login default.
  - **Committed repo workspace (dpws, 2026-11-01):** `.claude/eocrm.json` `{"workspace": "<slug>", "region": "eu"|"ru"}` in the repo root. Only a slug (the slug pattern) and a region from the fixed list; any other key (URL, issuer, api, endpoints) is ignored. The first time a repo's committed workspace differs from the member's login default, `/eocrm:login`/the SessionStart hook asks once (SessionStart: one short line, no block) and records the answer in `repos.json`; until confirmed, hooks use the default and stay silent about the repo file. A declined repo stays on the default.
  - **Single workspace (dpws, 2026-11-01):** `/eocrm:login` without a slug lists the member's workspaces in the region (eocrm endpoint for agent:runs tokens, see eocrm follow-up) and picks the only one silently; with several, it asks. If the endpoint is missing (older eocrm), it asks for the slug as before.
  - Resolution order: worktree override (`--here`) → member's repos.json mapping → confirmed committed `.claude/eocrm.json` → the only workspace → login default.
  - Test: two worktrees of one repo (same origin, ssh vs https spelling) both resolve `beta` after one `use`; another repo still gets the default; `--here` wins in its worktree only.
  - A workspace the member has not signed into or paired yet: the first hook run there stays silent and `eocrm status` says `run /eocrm:login <workspace>`; the token is per identity and region, pairing is per workspace.
  - Missing workspace exits 2 with `workspace required`.
  - A missing or <20 Node major prints `eocrm needs Node 20+ on PATH`.
  - No CLI stdout or stderr contains the fixture's token strings.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `openBrowser`, with the URL as an argument and never through a shell string:
    - darwin: `open`;
    - win32: `rundll32 url.dll,FileProtocolHandler`;
    - WSL (`/proc/version` contains `microsoft`): `wslview`, else `cmd.exe /c start ""`;
    - else: `xdg-open`.
    - In every case it also prints the URL.
  - `commands/login.md` (≤ 120 words) tells the model to:
    1. ask the member for region and workspace slug if they were not given;
    2. run `node "${CLAUDE_PLUGIN_ROOT}/scripts/eocrm.mjs" login --data "${CLAUDE_PLUGIN_DATA}" --region <r> <slug>`;
    3. on `choose`, show the labels and run `pair <id>` for the member's pick;
    4. on `requested`, tell the member to approve in Account → Agents within 15 minutes.
  - `commands/use.md` is ≤ 60 words.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: /eocrm:login and /eocrm:use with pairing`.

**PR 1 ships:** lint, unit and contract tests green, then open the PR.

---

## PR 2 — Tracking hooks + outbox

### Task 7: Outbox, event ids and flush
**Files:**
- Create: `lib/ids.mjs`, `lib/outbox.mjs`, `lib/flush.mjs`
- Test: `test/unit/outbox.test.mjs`, `test/contract/flush.test.mjs`

**Interfaces:**
- Produces:
  - `eventId(type: string, naturalKey: string): string` → `${type}:${b64url(sha256(naturalKey)).slice(0, 22)}`.
  - `enqueue(data, entry: OutboxEntry): Promise<void>`. File: `${data}/outbox.jsonl`, under `withLock`. Bounded at **2,000** entries, dropping the oldest. A drop increments `${data}/dropped.json`.
  - `OutboxEntry` is one of:
    - `{kind: 'event', sessionId, event: {id, type, occurred_at, ...fields}}`
    - `{kind: 'start' | 'finish', sessionId}`
    - `{kind: 'step', sessionId, step}` (coalesced: only the newest pending `step` per session is kept)
    - `{kind: 'heartbeat', sessionId}` (coalesced)
  - `flush({data, sessionId?, deadlineMs, clientFor}): Promise<FlushResult>`.
    - `FlushResult = {sent: number, rejected: Rejection[], retryable: boolean}`.
    - Order per session: `start`, then events in batches of ≤ 100, then `step`, `heartbeat`, `finish`.
    - A batch never mixes `plan` sources (Ruling 5).
    - Classification (Ruling 7):
      - 200, 201 or 204 → remove the entries and mark them acked;
      - 422 with `errors` keys `events.<i>.*` → reject those entries and resend the rest; any other 422, 400 or 403 → reject the batch;
      - 401 → the client already refreshed, so leave the entries and set `signedOut`;
      - 404 or 409 on a run → roll the generation, re-queue `start` and keep the events;
      - 429, 5xx or network → keep the entries, `retryable: true`.
    - Rejected entries move to `${data}/rejected.jsonl` and into `run.rejected`.

- [ ] **Step 1: Tests.**
  - `eventId` is ≤ 64 characters and deterministic.
  - 2,001 enqueues keep 2,000 and drop the first.
  - Two concurrent enqueue loops of 100 each leave 200 lines.
  - Contract tests:
    - flushing twice sends the same event ids, and the second flush gets `duplicates == n`;
    - a fixture 422 on `events.1.url` rejects only entry 1;
    - a fixture 409 `run_ended` leads to `start` with `client_run_id` `<session>.1`;
    - a 503 keeps every entry and sets `retryable`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: bounded idempotent outbox`.

### Task 8: Hook dispatcher, run lifecycle, linking and heartbeat
**Files:**
**Model on the run (dpws, 2026-11-01).** The run shows which model did the work (Claude Code can route to OpenRouter or other providers):
- read the model id from the hook input when present, else from the session transcript's latest assistant message (`message.model`); never ask the model;
- send it as a `usage` event `{model}` (eocrm already accepts `usage.model`, max 100 chars) at run start and whenever it changes (`/model` switch), deduped by event id `model-<hash(model)>-<generation>`;
- scrub with `clean()`; an unreadable transcript sends nothing (silent);
- test: a transcript fixture with two models in sequence yields exactly two usage events; no transcript → none.
- eocrm side (PR B): the run DTO exposes the latest usage `model`, and the run chip/panel shows `Claude Code · <model>`.
- Create: `hooks/hooks.json`, `hooks/dispatch.mjs`, `lib/run.mjs`
- Modify: `scripts/eocrm.mjs` (add `link <KEY|none>`)
- Test: `test/unit/dispatch.test.mjs`, `test/contract/run.test.mjs`

**Interfaces:**
- Consumes: T3, T5, T7.
- Produces:
  - `hooks.json`. Every entry uses `type: command`, `command: node`, and `args: ["${CLAUDE_PLUGIN_ROOT}/hooks/dispatch.mjs", "<event>"]`.

    | event | matcher | async | timeout |
    |---|---|---|---|
    | `SessionStart` | `startup\|resume\|clear\|compact\|fork` | false | 10 |
    | `UserPromptSubmit` | — | true | — |
    | `PreToolUse` | `Agent\|Task` | true | — |
    | `PostToolUse` | `Bash\|Write\|Edit\|MultiEdit\|TodoWrite\|TaskCreate\|TaskUpdate\|Agent\|Task` | true | — |
    | `PostToolUseFailure` | `Bash` | true | — |
    | `Stop` | — | false | 30 |
    | `SessionEnd` | — | false | — |

  - `handle(event: string, input: object, ctx: {data, env, now}): Promise<{stdout?: string}>`. `dispatch.mjs` wraps it with a catch-all that logs, exits 0 and prints only `stdout`.
  - `ensureRun(ctx, input): Promise<RunState>` on SessionStart.
    - `client_run_id` is `session_id`, with a generation suffix from Ruling 4.
    - It sends `task` only from the worktree link, and otherwise `branch`, `worktree` and `repo` (T9 `repoSlug`).
    - It finishes any older still-running run of the same worktree.
    - It enqueues `start` and spawns a detached `node dispatch.mjs flush` (`detached`, `stdio: 'ignore'`, `windowsHide`, `unref`).
  - `linkContext(worktree, branch, worktreeRoot): string|null` returns the link ask when no key is in the branch or folder, and `taskKey`/`linkAnswered` are unset. The ask is exactly:
    `eocrm: this session isn't linked to a task. Ask the member once which task key it is for (or "none"), then use the eocrm link-run skill.`
  - Heartbeat: enqueued from any hook when `now - lastHeartbeatAt ≥ 120 s`.
  - SessionEnd: enqueue `finish` (state `finished`) and spawn a detached flush. It must return within 1 s.
  - `eocrm link <KEY|none>`: saves the worktree answer and, with a key, enqueues an `updateRun` `{task}`.

- [ ] **Step 1: Tests.**
  - Malformed stdin, an unwritable `--data`, or `git` missing from PATH → exit 0 and empty stdout (spawned for real).
  - SessionStart on branch `feat/AB-12-x` → no stdout, and the start body has `branch` and no `task`.
  - On branch `main` with no link → stdout parses as `{hookSpecificOutput: {hookEventName: 'SessionStart', additionalContext: <the exact ask>}}`.
  - After `link none` → no stdout on the next session.
  - SessionEnd → a `finish` entry is queued and the call returns in < 1 s with an unreachable server.
  - Contract: start → events → finish against the fixture server gives exactly POST runs, POST events, PATCH `{state: 'finished'}`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: run lifecycle hooks and task linking`.

### Task 9: Detectors for commits, test runs, PRs and SDD dispatch
**Files:**
- Create: `lib/detect.mjs`, `lib/git.mjs`
- Modify: `lib/run.mjs` (route PostToolUse, PostToolUseFailure and PreToolUse)
- Test: `test/unit/detect.test.mjs`, `test/unit/git.test.mjs`

**Interfaces:**
- Produces:
  - `repoSlug(cwd): string|null`. Takes `origin`'s URL with credentials stripped, and returns `owner/repo` for GitHub, GitLab or Bitbucket-style URLs. Otherwise the scrubbed host and path, ≤ 200 characters.
  - `branchCommits(cwd, limit = 200): Array<{sha, subject}>`, for `merge-base(HEAD, origin/HEAD|main|master)..HEAD`.
  - `testRun(input): {command, result_line, exit_code}|null`.
    - Command matcher: `/\b(make\s+(test|e2e|smoke)\b|npm\s+(run\s+)?test|pnpm\s+test|yarn\s+test|npx\s+(vitest|jest|playwright\s+test)|vitest|jest|pytest|go\s+test|cargo\s+test|phpunit|pest|rspec|mvn\s+test|gradle\w*\s+test|node\s+--test|dotnet\s+test)\b/`.
    - `result_line` is the last non-empty output line matching `/\b(pass(ed)?|fail(ed|ures?)?|errors?|tests?|ok)\b/i`, else the last non-empty line.
    - `exit_code` is 0 from PostToolUse, or parsed from `/Exit code (\d+)/` in PostToolUseFailure `error`.
  - `prEvent(input): {action: 'opened'|'merged', url, number}|null`.
    - `gh pr create`: the URL comes from stdout `/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/`.
    - `gh pr merge [arg]`: the URL comes from `gh pr view [arg] --json url -q .url` (5 s timeout, skipped if `gh` is missing).
    - Opened URLs are added to the worktree `openPrs`.
  - `isCommit(command): boolean` (`/\bgit\b[^|;&\n]*\bcommit\b/`). On a match, enqueue a `commit` event for each `branchCommits` sha not in `reportedCommits`, then add it there. Event id is `eventId('commit', sha)`.
  - `sddStep(input, ledgerPresent): {phase, label}|null`. PreToolUse `Agent|Task` gives `started`, PostToolUse gives `finished`. The label is `tool_input.description`. Event id is `eventId('step', tool_use_id + phase)`. Returns null when no SDD ledger is present (Ruling 14).
  - Every text field goes through `clean(…, LIMITS…)`.

- [ ] **Step 1: Tests.** The table-driven cases:
  - `npm test` output ending `Tests  3 passed (3)` → that line, exit 0;
  - PostToolUseFailure `Exit code 1\n…` → exit 1;
  - `git commit -m "fix" && make test` → both detected;
  - `curl -u me:pw https://x` → not a test run;
  - `gh pr create` stdout URL → opened with that number;
  - origin `https://user:ghp_FAKEfakeFAKEfakeFAKEfake00@github.com/o/r.git` → `o/r`;
  - `git@github.com:o/r.git` → `o/r`;
  - a temp git repo with 2 commits on a branch → 2 commit events, and a second call → 0.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: commit, test-run, PR and SDD detectors`.

**PR 2 ships:** lint, unit and contract tests green, then open the PR.

---

## PR 3 — Plans + reconciler + gate

### Task 10: Plan sources
**Files:**
- Create: `lib/plans.mjs`
- Test: `test/unit/plans.test.mjs`, fixtures `test/fixtures/plans/*.md` (CRLF and LF variants)

**Interfaces:**
- Produces:
  - `parseSuperpowers(text): {items: Array<{key: 'task-<N>', text: '<N>. <heading title>'}>, done: Set<string>}`.
    - One item per `/^### Task (\d+):\s*(.+)$/m`.
    - A task is in `done` when it has ≥ 1 step checkbox and all of them are `- [x]` (Ruling 8).
  - `parseMarkdown(text): {items, done}`.
    - One item per `/^\s*[-*] \[( |x|X)\] (.+)$/`.
    - Key: `md-<first 12 hex of sha256(normalised text)>`. A repeat gets `-2`, `-3`, and so on.
  - `parseTodos(toolInput): {items, done}`.
    - TodoWrite `todos[]`: key `todo-<12 hex of content>`, done when `status === 'completed'`.
    - TaskCreate/TaskUpdate: key `todo-<task_id>`, kept in `run.todos` across calls.
  - `parseLedger(text): {plan: string, complete: Set<number>, rounds: Array<{task, round, summary}>}`.
    - First line: `# SDD ledger — plan: <path>`.
    - `Task N: complete` marks a task complete.
    - `Task N: fix round R/5 (…)` is a round.
  - `activePlan(cwd, run): {source: 'superpowers'|'markdown'|'todo', path?: string, items, done}|null`.
    - Precedence:
      1. the plan named by a ledger under `.superpowers/sdd/*/progress.md`;
      2. else the newest `docs/superpowers/plans/*.md` changed on the branch (`git diff --name-only base...HEAD` plus untracked or modified files);
      3. else a markdown file the session wrote (from `Write`/`Edit` `file_path`) containing `- [ ]`;
      4. else the todo list.
    - A file with `### Task` headings is `superpowers`, with steps ignored.
    - `path` is repo-relative with `/`.

- [ ] **Step 1: Tests.**
  - A 3-task plan → keys `task-1..3`, and the task whose steps are all `[x]` is in `done`.
  - The CRLF fixture parses identically.
  - Duplicate checklist lines → `md-…`, `md-…-2`.
  - Ledger `Task 2: complete` → `complete.has(2)`.
  - The ledger plan wins over a newer plan file.
  - A Windows-style session path `C:\r\docs\superpowers\plans\x.md` with root `C:\r` → `docs/superpowers/plans/x.md`.
  - More than 200 items → the first 200, and a step event `plan truncated at 200 items` is noted once.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: superpowers, markdown and todo plan sources`.

### Task 11: Reconciler and conventions cache
**Files:**
- Create: `lib/reconcile.mjs`
- Modify: `lib/run.mjs` (call it at run start, at Stop, and from PostToolUse at most every **5 min**; also call it after any `Write`/`Edit` to a ledger or the active plan file, and after `TodoWrite`/`Task*`)
- Test: `test/unit/reconcile.test.mjs`, `test/contract/reconcile.test.mjs`

**Interfaces:**
- Consumes: T7 `enqueue`/`eventId`, T9 git and PR helpers, T10 `activePlan`/`parseLedger`.
- Produces:
  - `desiredEvents(ctx, run): Event[]`. Built in this order:
    1. **When `conventions.plan_import`:**
       - one `plan` event `{source, path?, items}`, with id `eventId('plan', source + path + JSON(items))`;
       - for each done item, `step` `{phase: 'finished', label: item.text, plan_key}`, with id `eventId('step', planIdentity + key + ':done')`.
    2. **SDD rounds** as `step` `finished` events, labelled `Task N review round R: <summary>`.
    3. **Branch commits** not yet reported.
    4. **For each `openPrs` URL:** `gh pr view <url> --json state` (skipped if `gh` is missing). `MERGED` gives a `pull_request` `merged` event, and the URL leaves `openPrs`.
  - The current step comes from the in-progress todo's `activeForm`, else the first item not done. It is enqueued as `step` only when it changes.
  - `reconcile(ctx, run): Promise<{enqueued: number}>`. Pushes only `desired − acked − serverSeen`.
    - At run start or resume (`serverEventsRead` false), it pages `listEvents` and builds `serverSeen` from payload identity: plan `(source, path, items)`, step `(plan_key, phase)`, commit `sha`, PR `(url, action)`.
    - It is idempotent: two calls with no change enqueue 0.
  - `loadConventions(ctx, run)`: `GET conventions` once per run, cached in `run.conventions`. If the call fails, the next reconcile tries again.

- [ ] **Step 1: Tests.**
  - Unit:
    - `plan_import` false → no plan or tick events;
    - a reconcile repeated twice → second `enqueued === 0`;
    - a done item already in `acked` → not re-sent;
    - a dropped outbox (the offline case) → the next reconcile re-derives the plan, ticks and commits;
    - ticks follow their own plan event within the batch.
  - Contract: a fixture run whose events already include the plan and 1 tick → reconcile at resume sends only the 2nd tick.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: idempotent reconciler`.

### Task 12: Stop-hook gate
**Files:**
- Create: `lib/gate.mjs`
- Modify: `lib/run.mjs` (Stop)
- Test: `test/unit/gate.test.mjs`, `test/contract/gate.test.mjs`

**Interfaces:**
- Consumes: T7 `flush`, T11 `reconcile`.
- Produces:
  - `stopGate(ctx, input): Promise<{stdout?: string}>`:
    1. `reconcile`;
    2. `flush` with `deadlineMs: 20000`;
    3. take this session's unblocked rejections;
    4. if there are none, or the fingerprint (`sha256` of the sorted ids) is already in `blockedFingerprints`, return `{}`;
    5. otherwise record the fingerprint and return the block JSON below.
  - Block JSON: `{"decision": "block", "reason": R}`, where R is exactly:
    `eocrm refused <n> tracking update(s): ` + up to 5 × `<type> "<label>" (<status> <code|message>)`, joined by `; `, then `. Fix what it names or tell the member; tracking continues.`
    The reason is scrubbed and ≤ 1,000 characters.
  - `stop_hook_active` stops a re-block on a seen fingerprint.

- [ ] **Step 1: Tests.**
  - The fixture answers 503 → `{}` and no stdout.
  - Network refused → `{}`.
  - 401 → `{}`, and `eocrm status` shows signed out.
  - 422 on one event → a block naming its type and label.
  - The same rejection with `stop_hook_active: true` → `{}`.
  - A new rejection → a block again.
  - A tracking refusal recorded server-side as `review_finding` with a 200 response → `{}`, since only 4xx blocks.
  - The gate returns within 25 s against a server that hangs.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: Stop-hook gate on 4xx rejections`.

**PR 3 ships:** lint, unit and contract tests green, then open the PR.

---

## PR 4 — Skills, proof, release

### Task 13: Skills and the judgement CLI
**Files:**
- Create: `skills/link-run/SKILL.md`, `skills/file-human-work/SKILL.md`, `skills/pick-type/SKILL.md`, `skills/record-judgement/SKILL.md`
- Modify: `scripts/eocrm.mjs`. Add:
  - `record ruling --what --why [--cost-if-wrong]`;
  - `record finding --severity critical|important|minor|theoretical --summary [--outcome open|fixed|accepted|disputed|dropped]`;
  - `conventions` (compact JSON: types, `human_space`, priorities, switches; no workflows).
- Test: `test/unit/skills.test.mjs`, `test/unit/record.test.mjs`

**Interfaces:**
- Consumes: T7 `enqueue`, T11 `run.conventions`.
- Produces: the four skills.
  - **Frontmatter:** `name`, and a `description` of ≤ 200 characters.
  - **Body:** ≤ 1,200 characters. Every call is `node "${CLAUDE_PLUGIN_ROOT}/scripts/eocrm.mjs" … --data "${CLAUDE_PLUGIN_DATA}"`.
  - **Content per skill:**
    - `link-run`: `eocrm link <KEY|none>`.
    - `file-human-work`: create the task with the eocrm MCP tasks tool in `human_space`, blocked by nothing and blocking the agent's task. If `human_space` is null, ask the member.
    - `pick-type`: use the Conventions types. If one is null, ask; never guess.
    - `record-judgement`: the `record` subcommands, with the rule "rulings, review findings and splits only".
  - **Wording:** roles only ("the member", "the agent"), no tenant keys or person names.

- [ ] **Step 1: Tests.**
  - Each `SKILL.md` parses, meets its length caps, and every `${…}` is `CLAUDE_PLUGIN_ROOT` or `CLAUDE_PLUGIN_DATA`.
  - A grep finds no `EO-`, `dpws` or ULID shape in `skills/`, `commands/` or `lib/`.
  - `record ruling --what x --why "API_KEY=abc"` enqueues a `ruling` with `why === 'API_KEY=[redacted]'` and a deterministic id.
  - An invalid severity exits 2.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: judgement skills and record CLI`.

### Task 14: Replay contract tests and the budget test
**Files:**
- Create: `test/replay/sessions/{linked-sdd,unlinked-ruling,gate-rejection}.jsonl`. Each line is `{hook, input, fs?, git?}`: the recorded hook inputs plus the repo state each step needs.
- Create: `test/replay/expected/<name>.json` (the exact request list)
- Create: `test/support/replay.mjs`, `test/contract/replay.test.mjs`, `test/budget/budget.test.mjs`

**Interfaces:**
- Consumes: T8 `handle`, T5 fixture server.
- Produces:
  - `replay(sessionFile, {server, data}): Promise<{requests, injected: Array<{source, text}>}>`. It builds a temp git repo, runs each line through `handle` in order, and flushes after each.
  - `injected` collects:
    - SessionStart `additionalContext`;
    - Stop block reasons;
    - every skill and command `description`, once per session;
    - the body of each skill or command the recording invokes.

- [ ] **Step 1: Tests.**
  - Contract:
    - for each session, `requests` (method, path, body with ids and timestamps normalised) deep-equals `expected/<name>.json`;
    - replaying the same session again on the same data dir and server makes eocrm-visible state unchanged: every event response reports `duplicates == sent` and no new run;
    - no captured request, file under `data` or output contains the fixture token.
  - Budget: for each session, `sum(ceil(utf8Bytes(text) / 3)) ≤ 2000`. On failure, print the per-source breakdown.
- [ ] **Step 2: Run** `npm run test:contract && npm run test:budget`. Expected: FAIL until the recordings and expected lists exist.
- [ ] **Step 3: Implement** the replay harness. Record the three sessions by hand from the hook schemas: an SDD plan with 2 tasks, commits, `make test`, `gh pr create`/merge; an unlinked session with the link ask and one ruling; and a 422 rejection. Write the expected lists by reading them off a verified run.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `test: replay contract and token budget`.

### Task 15: CI, nightly smoke, marketplace and README
**Files:**
- Modify: `.github/workflows/ci.yml` (add the `contract` and `budget` jobs on ubuntu; the OS matrix stays on unit)
- Create: `.github/workflows/nightly-smoke.yml`, `test/smoke/live.test.mjs`
- Create: `.claude-plugin/marketplace.json`, `README.md`
- Test: `test/unit/marketplace.test.mjs`

**Interfaces:**
- Produces:
  - `marketplace.json`: `{name: 'eocrm', owner: {name: 'eocrm'}, description, plugins: [{name: 'eocrm', source: './', description}]}`. The version is not duplicated, so `plugin.json` wins.
  - **Nightly smoke**, `schedule: cron '30 3 * * *'` plus `workflow_dispatch`. Secrets are OPS-2 placeholders:
    - `EOCRM_SMOKE_REGION`, `EOCRM_SMOKE_WORKSPACE`, `EOCRM_SMOKE_TASK`, `EOCRM_SMOKE_CLIENT_ID`, `EOCRM_SMOKE_REFRESH_TOKEN` (OPS-2 set up workspace `test` with task `TEST-1` and Conventions; those two go in as repo variables, not hardcoded);
    - `SMOKE_SECRETS_PAT` (secrets write), used to `gh secret set EOCRM_SMOKE_REFRESH_TOKEN` with the rotated token (Ruling 13).
  - **The smoke run** goes through `createClient` with REST only:
    1. refresh;
    2. `startRun({client_run_id: 'smoke-<YYYYMMDD>-<run_id>', task: EOCRM_SMOKE_TASK})`;
    3. `recordEvents` with plan, step, commit and test_run;
    4. `listEvents` reads them back;
    5. the same batch is replayed and must return `duplicates === 4`;
    6. `updateRun` sets state `finished`.
  - When the secrets are absent, the smoke prints `::warning::smoke credentials not set (OPS-2)` and exits 0.
  - No job installs or runs `claude`.
  - **README:**
    - install: `/plugin marketplace add eocrm/claude-plugin`, then `/plugin install eocrm@eocrm` (private repo: needs git access);
    - prerequisites: Node 20+ on PATH, `git`, optional `gh`;
    - `/eocrm:login`, `/eocrm:use`, what is sent, scrubbing, the keychain and its fallback, "tracking stale", troubleshooting via `eocrm status`;
    - a local pre-release step: `claude plugin validate --strict .`.

- [ ] **Step 1: Tests.** `marketplace.test.mjs`: the required keys are present, `plugins[0].source === './'`, and the entry name equals the `plugin.json` name.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Run `claude plugin validate --strict .` locally and record the result line in the PR body.
- [ ] **Step 4: Run** `npm run lint && npm test && npm run test:contract && npm run test:budget`. Expected: PASS.
- [ ] **Step 5: Commit** `ci: contract, budget and nightly smoke; marketplace and README`.

**PR 4 ships:** all suites green, the validate line is in the PR body, then open the PR. OPS-2 (smoke credentials) remains a human task.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handle, runClient } from '../../lib/run.mjs';
import { flush } from '../../lib/flush.mjs';
import { segments } from '../../lib/detect.mjs';
import { main } from '../../scripts/eocrm.mjs';
import { startFixtureServer } from './fixture-server.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const HOOKS = JSON.parse(readFileSync(join(ROOT, 'hooks/hooks.json'), 'utf8')).hooks;
const T0 = Date.parse('2026-11-01T10:00:00Z');
// Fixed identity and dates make commit shas, and so commit event ids, the same on every run.
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: '2026-11-01T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-01T10:00:00Z' };
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g;
const RUN_ID = /01JZRUN\d+/g;

export const tmp = (p) => realpathSync.native(mkdtempSync(join(tmpdir(), `eocrm-${p}-`)));

export function signedIn() {
  const data = tmp('data');
  writeFileSync(join(data, 'account.json'), JSON.stringify({ region: 'eu', workspace: 'acme', workspaces: { acme: 'standalone' } }));
  return data;
}

export const SESSIONS = ['linked-sdd', 'unlinked-ruling', 'gate-rejection', 'permission-resume'];
export const sessionFile = (name) => join(ROOT, 'test/replay/sessions', `${name}.jsonl`);
const CONVENTIONS = JSON.parse(readFileSync(join(ROOT, 'test/contract/responses/agentWorkConventions.show.json'), 'utf8'));

// Plans import, and eocrm refuses any commit subject "WIP".
export const startReplayServer = (conventions = {}) => startFixtureServer({
  responses: {
    'agentWorkConventions.show': { status: 200, body: { ...CONVENTIONS, plan_import: true, ...conventions } },
    'agentRun.events.store': ({ body }) => {
      const i = body.events.findIndex((e) => e.type === 'commit' && e.subject === 'WIP');
      return i < 0 ? undefined : { status: 422, body: { message: 'The given data was invalid.', errors: { [`events.${i}.subject`]: ['The subject is not allowed.'] } } };
    },
  },
});

const gitIn = (cwd, args) => execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' });

function frontmatter(file) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(readFileSync(file, 'utf8'));
  return { description: /^description: (.+)$/m.exec(m[1])[1], body: m[2] };
}

export function catalog() {
  const skills = readdirSync(join(ROOT, 'skills')).map((n) => [`skill:${n}`, frontmatter(join(ROOT, 'skills', n, 'SKILL.md'))]);
  const commands = readdirSync(join(ROOT, 'commands')).map((f) => [`command:${f.slice(0, -3)}`, frontmatter(join(ROOT, 'commands', f))]);
  return new Map([...skills, ...commands]);
}

// The dispatch events Claude Code would run for this hook, in hooks.json order.
function hookRuns(hook, input) {
  const key = hook === 'SessionStart' ? input.source : TOOL_EVENTS.has(hook) ? input.tool_name : hook === 'Notification' ? input.notification_type : null;
  return (HOOKS[hook] ?? []).filter(({ matcher }) => !matcher || matcher === '*' || new RegExp(`^(?:${matcher})$`).test(key ?? '')).map((g) => g.hooks[0].args[1]);
}

function cliArgs(command, data) {
  const words = segments(command).find((w) => w.some((x) => x.endsWith('scripts/eocrm.mjs')));
  if (!words) return null;
  return words.slice(words.findIndex((x) => x.endsWith('scripts/eocrm.mjs')) + 1).map((x) => x.replaceAll('${CLAUDE_PLUGIN_DATA}', data));
}

export function normalise(entry, { repo, data }) {
  const text = JSON.stringify(entry).replace(ISO, '<time>').replace(RUN_ID, ':id').replaceAll(data, '<data>').replaceAll(basename(repo), '<repo>');
  return JSON.parse(text);
}

const noGh = (cmd, args, opts) => {
  if (cmd === 'gh') throw Object.assign(new Error('gh not installed'), { code: 'ENOENT' });
  return execFileSync(cmd, args, opts);
};

// Each line: {hook, input, fs?: {path: text}, git?: [[args]]}; ${REPO} in a line is the temp repo.
export async function replay(sessionFile, { server, data }) {
  const repo = tmp('repo');
  gitIn(repo, ['init', '-q', '-b', 'main']);
  gitIn(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);
  gitIn(repo, ['remote', 'add', 'origin', 'git@github.com:o/r.git']);
  const tokens = { access_token: server.auth.access, refresh_token: server.auth.refresh, client_id: server.auth.clientId };
  const store = { get: async () => tokens, update: async () => null, del: async () => {} };
  let at = T0;
  const ctx = { data, env: server.endpointsEnv, now: () => at, store, spawnFlush: () => {}, git: { exec: noGh } };
  const sid = basename(sessionFile, '.jsonl');
  const known = catalog();
  const injected = [...known].map(([source, { description }]) => ({ source: `${source} description`, text: description }));
  const outputs = [];
  const from = server.requests.length;
  const lines = readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean);
  for (const raw of lines) {
    const line = JSON.parse(raw.replaceAll('${REPO}', JSON.stringify(repo).slice(1, -1)));
    at += 1000;
    for (const [path, text] of Object.entries(line.fs ?? {})) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
    for (const args of line.git ?? []) gitIn(repo, args);
    const input = { session_id: sid, cwd: repo, hook_event_name: line.hook, ...line.input };
    const skill = line.hook === 'PreToolUse' && input.tool_name === 'Skill' && /^eocrm:(.+)$/.exec(input.tool_input?.skill ?? '');
    const command = line.hook === 'UserPromptSubmit' && /^\/eocrm:(\S+)/.exec(input.prompt ?? '');
    const invoked = skill ? `skill:${skill[1]}` : command ? `command:${command[1]}` : null;
    if (invoked) injected.push({ source: `${invoked} body`, text: known.get(invoked).body });
    const args = line.hook === 'PostToolUse' && input.tool_name === 'Bash' && cliArgs(input.tool_input.command, data);
    if (args) {
      const out = [];
      await main({ argv: args, env: server.endpointsEnv, cwd: repo, out: (l) => out.push(l), err: (l) => out.push(l), store, spawnFlush: () => {} });
      input.tool_response = { stdout: out.join('\n'), stderr: '', interrupted: false };
      injected.push({ source: `cli ${args[0]}`, text: input.tool_response.stdout });
    }
    for (const event of hookRuns(line.hook, input)) {
      const { stdout } = await handle(event, input, ctx);
      if (stdout) {
        outputs.push(stdout);
        const o = JSON.parse(stdout);
        if (o.hookSpecificOutput?.additionalContext) injected.push({ source: `${line.hook} additionalContext`, text: o.hookSpecificOutput.additionalContext });
        if (o.decision === 'block') injected.push({ source: 'Stop reason', text: o.reason });
      }
    }
    await flush({ data, deadlineMs: 5000, clientFor: runClient(ctx) });
  }
  const log = server.requests.slice(from);
  return { requests: log.map(({ method, path, body }) => normalise({ method, path, body }, { repo, data })), injected, outputs, log, repo };
}

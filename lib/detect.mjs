import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, win32 } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { repoSlug, branchCommits, budget, localBranches, prView, prState } from './git.mjs';
import { git, worktreeOf, loadWorktree, saveWorktree, readJson, writeJsonAtomic } from './state.mjs';
import { append } from './outbox.mjs';
import { eventId } from './ids.mjs';
import { clean, LIMITS } from './scrub.mjs';
import { pathFor } from './plans.mjs';

const MARK = /^test:\s*/;
const SUMMARY = /\b(pass(ed)?|fail(ed|ures?)?|errors?|tests?|ok)\b/i;
const EXIT = /Exit code (\d+)/;
const COMMIT = /\bgit\b[^|;&\n]*\bcommit\b/;
const PR_URL = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/;
const WRAPPER = new Set(['sudo', 'time', 'env', 'nice', 'nohup', 'exec', 'command']);
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
const MAX_PARSE = 64 * 1024;
const ANSI = new RegExp(String.raw`\x1b\[[0-9;?]*[ -/]*[@-~]`, 'g');
const TAIL = 64 * 1024;
const KEEP_COMMITS = 1000;
const DETECT_MS = 8000;
const KEEP_PRS = 100;
const AGENT = new Set(['Agent', 'Task']);
export const TASK_KEY = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]{1,9}-[0-9]+(?![A-Za-z0-9])/;
const KEEP_PATHS = 50;
const MSYS_DRIVE = /^\/([A-Za-z])(?:\/|$)/;

const isBash = (input) => input?.tool_name === 'Bash' && typeof input.tool_input?.command === 'string';

export function output(input) {
  if (input.hook_event_name === 'PostToolUseFailure') {
    const error = String(input.error ?? '');
    const code = EXIT.exec(error);
    return code && { exit: Number(code[1]), text: error.slice(code.index + code[0].length) };
  }
  const r = input.tool_response;
  if (typeof r === 'string') return { exit: null, text: r };
  if (!r || r.interrupted) return null;
  return { exit: r.exit === undefined ? 0 : Number.isInteger(r.exit) ? r.exit : null, text: [r.stdout, r.stderr].filter((s) => typeof s === 'string').join('\n') };
}

// Shell words per segment, split on unquoted ; & | ( ) and newlines.
export function segments(command) {
  const out = [[]];
  let word = null;
  let quote = null;
  const end = () => {
    if (word !== null) out.at(-1).push(word);
    word = null;
  };
  const text = command.slice(0, MAX_PARSE);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else word += c === '\\' && quote === '"' && /["\\$`]/.test(text[i + 1] ?? '') ? text[++i] : c;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= '';
    } else if (c === '\\' && i + 1 < text.length) word = (word ?? '') + text[++i];
    else if (/[;&|()\n]/.test(c)) {
      end();
      if (out.at(-1).length) out.push([]);
    } else if (/\s/.test(c)) end();
    else word = (word ?? '') + c;
  }
  end();
  return out.filter((s) => s.length);
}

function commandWords(words) {
  let i = 0;
  while (i < words.length && (ASSIGNMENT.test(words[i]) || WRAPPER.has(words[i]) || (i > 0 && WRAPPER.has(words[i - 1]) && words[i].startsWith('-')))) i++;
  const rest = words.slice(i);
  if (rest.length) rest[0] = rest[0].split(/[\\/]/).at(-1);
  return rest;
}

export const segmentWords = (command) => segments(command).map(commandWords).filter((w) => w.length);

export function testRun(input) {
  if (!isBash(input) || input.tool_input.run_in_background || input.is_interrupt) return null;
  const { command, description } = input.tool_input;
  if (typeof description !== 'string' || !MARK.test(description)) return null;
  const label = description.replace(MARK, '').trim();
  const out = output(input);
  if (!label || !out) return null;
  const line = out.text.slice(-TAIL).replace(ANSI, '').split(/\r?\n|\r/).map((l) => l.trim()).findLast((l) => SUMMARY.test(l));
  return { command: clean(command, LIMITS.testCommand), label: clean(label, LIMITS.stepLabel), result_line: line ? clean(line, LIMITS.resultLine) : null, exit_code: out.exit };
}

export const isCommit = (command) => COMMIT.test(command);

const MERGE_VALUE_FLAG = /^(-[bFtAR]|--(repo|body|body-file|subject|author-email|match-head-commit))$/;
const CREATE_HEAD_FLAG = /^(-H|--head)$/;

function argOf(args, valueFlag) {
  for (let i = 0; i < args.length; i++) {
    if (valueFlag.test(args[i])) i++;
    else if (!args[i].startsWith('-')) return args[i].replace(/^#(?=\d+$)/, '');
  }
  return null;
}

const flagValue = (args, flag) => {
  const i = args.findIndex((a) => flag.test(a));
  return i >= 0 ? args[i + 1] ?? null : (args.find((a) => /^--head=/.test(a))?.slice(7) ?? null);
};

const pr = (action, url, extra = {}) => {
  const m = PR_URL.exec(url ?? '');
  return m && { action, url: m[0], number: Number(m[1]), ...extra };
};

const ghPr = (command, sub) => segmentWords(command).find((w) => w[0] === 'gh' && w[1] === 'pr' && w[2] === sub)?.slice(3);

// open() is [{branch, url}] recorded at create; it outlives a branch that --delete-branch removed.
const CONFIRM = { opened: 'OPEN', merged: 'MERGED' };
const GH_EXISTS = /a pull request for branch "[^"]*" into branch "[^"]*" already exists/;

// Codex reports failed commands too, without an exit code: ask GitHub before trusting the output.
export function prEvent(input, { state = () => null, ...opts } = {}) {
  const e = prGuess(input, opts);
  const out = output(input);
  if (!e || out?.exit !== null) return e;
  if (e.action === 'opened' && GH_EXISTS.test(out.text)) return null;
  return state(e.url) === CONFIRM[e.action] ? e : null;
}

function prGuess(input, { view = prView, open = () => [], branch = () => null, branches = () => null } = {}) {
  if (!isBash(input) || input.hook_event_name === 'PostToolUseFailure') return null;
  const { command } = input.tool_input;
  const create = ghPr(command, 'create');
  if (create) return pr('opened', output(input)?.text.slice(-TAIL), { branch: flagValue(create, CREATE_HEAD_FLAG) ?? branch() });
  const args = ghPr(command, 'merge');
  if (!args || args.some((a) => a === '--auto' || a === '--disable-auto')) return null;
  const arg = argOf(args, MERGE_VALUE_FLAG);
  if (PR_URL.test(arg ?? '')) return pr('merged', arg);
  const stored = open();
  const byNumber = (n) => stored.find((p) => PR_URL.exec(p.url)?.[1] === n);
  if (arg) return pr('merged', (/^\d+$/.test(arg) ? byNumber(arg) : stored.find((p) => p.branch === arg))?.url ?? view(input.cwd, arg));
  const current = branch();
  const hit = stored.find((p) => p.branch && p.branch === current);
  if (hit) return pr('merged', hit.url);
  if (!args.some((a) => a === '-d' || a === '--delete-branch')) return pr('merged', view(input.cwd, null));
  const local = branches();
  const gone = local ? stored.filter((p) => p.branch && !local.includes(p.branch)) : [];
  return gone.length === 1 ? pr('merged', gone[0].url) : null;
}

export function sddStep(input, ledgerPresent) {
  if (!ledgerPresent || !AGENT.has(input?.tool_name)) return null;
  const r = input.tool_response;
  const background = input.tool_input?.run_in_background === true || r?.isAsync === true || r?.status === 'async_launched';
  const phase = { PreToolUse: 'started', PostToolUse: background ? null : 'finished' }[input.hook_event_name];
  const label = input.tool_input?.description;
  if (!phase || typeof label !== 'string' || !label.trim()) return null;
  return { phase, label: clean(label, LIMITS.stepLabel) };
}

// agent-<id>.meta.json is undocumented Claude Code internals.
export function subagentFinish(input) {
  const tp = input.transcript_path;
  const path = typeof input.agent_transcript_path === 'string' && input.agent_transcript_path ? input.agent_transcript_path
    : typeof tp === 'string' && /^[\w-]+$/.test(input.agent_id ?? '') ? join(dirname(tp), basename(tp, '.jsonl'), 'subagents', `agent-${input.agent_id}.jsonl`) : null;
  const meta = path ? readJson(path.replace(/\.jsonl$/, '.meta.json'), null) : null;
  if (meta?.requestShape !== 'background' || typeof meta.toolUseId !== 'string') return null;
  return { ...input, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: meta.toolUseId, tool_input: { description: meta.description }, tool_response: {} };
}

export function ledgerPresent(root) {
  try {
    const dir = join(root, '.superpowers', 'sdd');
    return readdirSync(dir).some((d) => existsSync(join(dir, d, 'progress.md')));
  } catch {
    return false;
  }
}

// The call's directory: hook cwd, Codex workdir, then a leading cd; null when a cd leaves it unknown.
function callDir(input) {
  const cwd = pathFor(input.cwd).resolve(input.cwd, typeof input.tool_input?.workdir === 'string' ? input.tool_input.workdir : '.');
  const first = isBash(input) ? segments(input.tool_input.command)[0] : null;
  if (first?.[0] !== 'cd') return cwd;
  if (first.length === 1 || first[1] === '-') return null;
  if (first.length !== 2 || first[1].startsWith('-')) return cwd;
  return cdTarget(cwd, first[1].replace(/^~(?=\/|$)/, homedir()));
}

// Git-bash on Windows spells C:\x as /c/x.
export function cdTarget(cwd, arg) {
  const p = pathFor(cwd);
  return p.resolve(cwd, p === win32 ? arg.replace(MSYS_DRIVE, (_, d) => `${d.toUpperCase()}:/`) : arg);
}

const branchOf = (gitDir) => {
  try {
    return /^ref: refs\/heads\/(.+)/.exec(readFileSync(join(gitDir, 'HEAD'), 'utf8'))?.[1] ?? '';
  } catch {
    return '';
  }
};

// The worktree key and git dir are cached per session; the branch is read from HEAD on every call.
function worktreeTask(ctx, input, run) {
  try {
    const dir = callDir(input);
    if (!dir || !existsSync(dir) || !/^[\w-]+$/.test(input.session_id)) return null;
    const file = join(ctx.data, 'paths', `${input.session_id}.json`);
    const cache = readJson(file, {});
    let hit = cache[dir];
    if (!hit) {
      const [top, gitDir] = git(dir, ['rev-parse', '--show-toplevel', '--absolute-git-dir'], run).split('\n');
      hit = { key: worktreeOf(dir, run, top ?? '').key, gitDir: gitDir ?? '' };
      if (gitDir) writeJsonAtomic(file, Object.fromEntries([...Object.entries(cache), [dir, hit]].slice(-KEEP_PATHS)));
    }
    return loadWorktree(ctx.data, hit.key).taskKey ?? (hit.gitDir ? TASK_KEY.exec(branchOf(hit.gitDir))?.[0] : null) ?? null;
  } catch {
    return null;
  }
}

// Git runs now, outside the lock; the session's task is read under it.
export function taskFor(ctx, input, run = budget(DETECT_MS, ctx.git)) {
  const own = worktreeTask(ctx, input, run);
  return (session) => own ?? session?.start?.task ?? null;
}

// Git and gh run before the lock, inside one budget; the returned closure queues under it.
export function detector(ctx, input) {
  const { data } = ctx;
  const sid = input.session_id;
  const run = budget(DETECT_MS, ctx.git);
  const command = input.tool_name === 'Bash' ? String(input.tool_input?.command ?? '') : '';
  const called = callDir(input);
  const dir = called && existsSync(called) ? called : input.cwd;
  let wt;
  const wtOf = () => (wt ??= worktreeOf(dir, run));
  const test = testRun(input);
  const commits = command && isCommit(command) ? branchCommits(dir, 200, run) : [];
  const repo = commits.length ? repoSlug(dir, git(dir, ['remote', 'get-url', 'origin'], run)) : null;
  const pull = prEvent(input, {
    view: (_, arg) => prView(dir, arg, run),
    state: (url) => prState(dir, url, run),
    open: () => loadWorktree(data, wtOf().key).openPrs.filter((p) => typeof p?.url === 'string'),
    branch: () => git(dir, ['symbolic-ref', '--short', '-q', 'HEAD'], run) || null,
    branches: () => localBranches(dir, run),
  });
  const agentStep = sddStep(input, true);
  const step = agentStep && ledgerPresent(wtOf().root) ? agentStep : null;
  if (!test && !pull && !commits.length && !step) return () => false;
  if (commits.length || pull) wtOf();

  return (current, at, task_key = null) => {
    const occurred_at = new Date(at).toISOString();
    const queued = [];
    const queue = (type, key, fields) => queued.push({ kind: 'event', sessionId: sid, event: { id: eventId(type, key), type, occurred_at, ...fields, task_key } });
    if (test) queue('test_run', `${current.clientRunId}:${input.tool_use_id ?? randomUUID()}`, test);
    if (step) queue('step', `${input.tool_use_id ?? randomUUID()}${step.phase}`, step);
    if (commits.length || pull) {
      const worktree = loadWorktree(data, wt.key);
      const reported = new Set(worktree.reportedCommits);
      const fresh = commits.filter((c) => !reported.has(c.sha));
      for (const c of fresh) queue('commit', c.sha, { sha: c.sha, subject: c.subject, ...(repo ? { repo } : {}) });
      let openPrs = worktree.openPrs.filter((p) => typeof p?.url === 'string');
      if (pull) {
        const { branch, ...event } = pull;
        queue('pull_request', `${pull.action}:${pull.url}`, { ...event, repo: pull.url.split('/').slice(3, 5).join('/') });
        openPrs = openPrs.filter((p) => p.url !== pull.url);
        if (pull.action === 'opened') openPrs = [...openPrs, { branch, url: pull.url }].slice(-KEEP_PRS);
      }
      saveWorktree(data, wt.key, { root: wt.root, reportedCommits: [...worktree.reportedCommits, ...fresh.map((c) => c.sha)].slice(-KEEP_COMMITS), openPrs });
    }
    if (queued.length) append(data, ...queued);
    return queued.length > 0;
  };
}

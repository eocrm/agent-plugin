import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { repoSlug, branchCommits, budget, localBranches, prView, prState } from './git.mjs';
import { git, worktreeOf, loadWorktree, saveWorktree } from './state.mjs';
import { append } from './outbox.mjs';
import { eventId } from './ids.mjs';
import { clean, LIMITS } from './scrub.mjs';

const TEST = /\b(make\s+(test|e2e|smoke)\b|npm\s+(run\s+)?test|pnpm\s+test|yarn\s+test|npx\s+(vitest|jest|playwright\s+test)|vitest|jest|pytest|go\s+test|cargo\s+test|phpunit|pest|rspec|mvn\s+test|gradle\w*\s+test|node\s+--test|dotnet\s+test)\b/;
const SUMMARY = /\b(pass(ed)?|fail(ed|ures?)?|errors?|tests?|ok)\b/i;
const EXIT = /Exit code (\d+)/;
const COMMIT = /\bgit\b[^|;&\n]*\bcommit\b/;
const PR_URL = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/;
const WRAPPER = new Set(['sudo', 'time', 'env', 'nice', 'nohup', 'exec', 'command']);
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
const TEST_WORDS = new RegExp(`^(?:${TEST.source})`);
const MAX_PARSE = 64 * 1024;
const ANSI = new RegExp(String.raw`\x1b\[[0-9;?]*[ -/]*[@-~]`, 'g');
const TAIL = 64 * 1024;
const KEEP_COMMITS = 1000;
const DETECT_MS = 8000;
const KEEP_PRS = 100;
const AGENT = new Set(['Agent', 'Task']);

const isBash = (input) => input?.tool_name === 'Bash' && typeof input.tool_input?.command === 'string';

function output(input) {
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

const segmentWords = (command) => segments(command).map(commandWords).filter((w) => w.length);

export function testRun(input) {
  if (!isBash(input) || input.tool_input.run_in_background || input.is_interrupt) return null;
  const { command } = input.tool_input;
  if (!segmentWords(command).some((w) => TEST_WORDS.test(w.join(' ')))) return null;
  const out = output(input);
  if (!out) return null;
  const lines = out.text.slice(-TAIL).replace(ANSI, '').split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean);
  const line = lines.findLast((l) => SUMMARY.test(l)) ?? lines.at(-1) ?? '';
  return { command: clean(command, LIMITS.testCommand), result_line: clean(line, LIMITS.resultLine), exit_code: out.exit };
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

// Codex reports failed commands too, without an exit code: ask GitHub before trusting the output.
export function prEvent(input, { state = () => null, ...opts } = {}) {
  const e = prGuess(input, opts);
  return e && output(input)?.exit === null && state(e.url) !== CONFIRM[e.action] ? null : e;
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
  const background = input.tool_input?.run_in_background === true;
  const phase = { PreToolUse: 'started', PostToolUse: background ? 'started' : 'finished' }[input.hook_event_name];
  const label = input.tool_input?.description;
  if (!phase || typeof label !== 'string' || !label.trim()) return null;
  return { phase, label: clean(label, LIMITS.stepLabel) };
}

export function ledgerPresent(root) {
  try {
    const dir = join(root, '.superpowers', 'sdd');
    return readdirSync(dir).some((d) => existsSync(join(dir, d, 'progress.md')));
  } catch {
    return false;
  }
}

// Git and gh run before the lock, inside one budget; the returned closure queues under it.
export function detector(ctx, input) {
  const { data } = ctx;
  const sid = input.session_id;
  const run = budget(DETECT_MS, ctx.git);
  const command = input.tool_name === 'Bash' ? String(input.tool_input?.command ?? '') : '';
  let wt;
  const wtOf = () => (wt ??= worktreeOf(input.cwd, run));
  const test = testRun(input);
  const commits = command && isCommit(command) ? branchCommits(input.cwd, 200, run) : [];
  const repo = commits.length ? repoSlug(input.cwd, git(input.cwd, ['remote', 'get-url', 'origin'], run)) : null;
  const pull = prEvent(input, {
    view: (cwd, arg) => prView(cwd, arg, run),
    state: (url) => prState(input.cwd, url, run),
    open: () => loadWorktree(data, wtOf().key).openPrs.filter((p) => typeof p?.url === 'string'),
    branch: () => git(input.cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], run) || null,
    branches: () => localBranches(input.cwd, run),
  });
  const agentStep = sddStep(input, true);
  const step = agentStep && ledgerPresent(wtOf().root) ? agentStep : null;
  if (!test && !pull && !commits.length && !step) return () => false;
  if (commits.length || pull) wtOf();

  return (current, at) => {
    const occurred_at = new Date(at).toISOString();
    const queued = [];
    const queue = (type, key, fields) => queued.push({ kind: 'event', sessionId: sid, event: { id: eventId(type, key), type, occurred_at, ...fields } });
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

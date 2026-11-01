import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { prView } from './git.mjs';
import { clean, LIMITS } from './scrub.mjs';

const TEST = /\b(make\s+(test|e2e|smoke)\b|npm\s+(run\s+)?test|pnpm\s+test|yarn\s+test|npx\s+(vitest|jest|playwright\s+test)|vitest|jest|pytest|go\s+test|cargo\s+test|phpunit|pest|rspec|mvn\s+test|gradle\w*\s+test|node\s+--test|dotnet\s+test)\b/;
const SUMMARY = /\b(pass(ed)?|fail(ed|ures?)?|errors?|tests?|ok)\b/i;
const EXIT = /Exit code (\d+)/;
const COMMIT = /\bgit\b[^|;&\n]*\bcommit\b/;
const PR_URL = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/;
const PR_CREATE = /\bgh\s+pr\s+create\b/;
const PR_MERGE = /\bgh\s+pr\s+merge\b([^|;&\n]*)/;
const ANSI = new RegExp(String.raw`\x1b\[[0-9;?]*[ -/]*[@-~]`, 'g');
const TAIL = 64 * 1024;
const AGENT = new Set(['Agent', 'Task']);

const isBash = (input) => input?.tool_name === 'Bash' && typeof input.tool_input?.command === 'string';

function output(input) {
  if (input.hook_event_name === 'PostToolUseFailure') {
    const error = String(input.error ?? '');
    const code = EXIT.exec(error);
    return code && { exit: Number(code[1]), text: error.slice(code.index + code[0].length) };
  }
  const r = input.tool_response;
  if (typeof r === 'string') return { exit: 0, text: r };
  if (!r || r.interrupted) return null;
  return { exit: 0, text: [r.stdout, r.stderr].filter((s) => typeof s === 'string').join('\n') };
}

export function testRun(input) {
  if (!isBash(input) || input.tool_input.run_in_background || input.is_interrupt) return null;
  const { command } = input.tool_input;
  if (!TEST.test(command)) return null;
  const out = output(input);
  if (!out) return null;
  const lines = out.text.slice(-TAIL).replace(ANSI, '').split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean);
  const line = lines.findLast((l) => SUMMARY.test(l)) ?? lines.at(-1) ?? '';
  return { command: clean(command, LIMITS.testCommand), result_line: clean(line, LIMITS.resultLine), exit_code: out.exit };
}

export const isCommit = (command) => COMMIT.test(command);

const MERGE_VALUE_FLAG = /^(-[bFtA]|--(body|body-file|subject|author-email|match-head-commit))$/;

function mergeArg(rest) {
  const tokens = (rest.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^(['"])(.*)\1$/, '$2'));
  for (let i = 0; i < tokens.length; i++) {
    if (MERGE_VALUE_FLAG.test(tokens[i])) i++;
    else if (!tokens[i].startsWith('-')) return tokens[i].replace(/^#(?=\d+$)/, '');
  }
  return null;
}

const pr = (action, url) => {
  const m = PR_URL.exec(url ?? '');
  return m && { action, url: m[0], number: Number(m[1]) };
};

export function prEvent(input, { view = prView } = {}) {
  if (!isBash(input) || input.hook_event_name === 'PostToolUseFailure') return null;
  const { command } = input.tool_input;
  if (PR_CREATE.test(command)) return pr('opened', output(input)?.text.slice(-TAIL));
  const merge = PR_MERGE.exec(command);
  if (!merge || /(^|\s)--(disable-)?auto\b/.test(merge[1])) return null;
  const arg = mergeArg(merge[1]);
  return pr('merged', PR_URL.test(arg ?? '') ? arg : view(input.cwd, arg));
}

export function sddStep(input, ledgerPresent) {
  if (!ledgerPresent || !AGENT.has(input?.tool_name)) return null;
  const phase = { PreToolUse: 'started', PostToolUse: 'finished' }[input.hook_event_name];
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

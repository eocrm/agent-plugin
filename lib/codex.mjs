import { basename, resolve } from 'node:path';

export const SHELL_TOOLS = new Set(['shell', 'local_shell', 'exec_command', 'container.exec']);
const SHELLS = new Set(['bash', 'sh', 'zsh']);
const PATCH_PATH = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm;
const SAME = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop']);

const quote = (w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`);

function command(ti) {
  const c = ti?.command ?? ti?.cmd;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  if (SHELLS.has(basename(String(c[0])))) {
    for (let i = 1; i < c.length - 1 && String(c[i]).startsWith('-'); i++) if (/^-[A-Za-z]*c[A-Za-z]*$/.test(c[i])) return String(c[i + 1]);
  }
  return c.map((w) => quote(String(w))).join(' ');
}

function response(r) {
  if (typeof r === 'string') return { stdout: r, stderr: '', exit: 0 };
  if (!r || typeof r !== 'object') return r;
  const exit = [r.exit_code, r.exitCode, r.exit].find(Number.isInteger) ?? 0;
  return { stdout: String(r.aggregated_output ?? r.formatted_output ?? r.output ?? r.stdout ?? ''), stderr: typeof r.stderr === 'string' ? r.stderr : '', exit };
}

function tool(input) {
  const ti = input.tool_input ?? {};
  if (SHELL_TOOLS.has(input.tool_name)) {
    return { ...input, tool_name: 'Bash', tool_input: { command: command(ti) }, tool_response: response(input.tool_response) };
  }
  if (input.tool_name === 'apply_patch') {
    const text = [ti.input, ti.patch, ti.command].flat().filter((s) => typeof s === 'string').join('\n');
    const file_paths = [...text.matchAll(PATCH_PATH)].map((m) => resolve(input.cwd ?? '', m[1].trim()));
    return { ...input, tool_name: 'Write', tool_input: { file_paths } };
  }
  if (input.tool_name === 'update_plan') {
    const plan = Array.isArray(ti.plan) ? ti.plan : [];
    return { ...input, tool_name: 'TodoWrite', tool_input: { todos: plan.filter((p) => typeof p?.step === 'string').map((p) => ({ content: p.step, status: p.status })) } };
  }
  return input;
}

const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

export function addModelUsage(run, input) {
  const u = input.token_usage;
  if (input.status !== 'completed' || !u || typeof input.model !== 'string' || !input.model) return null;
  const all = { ...run.codexUsage };
  const t = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, ...all[input.model] };
  t.input_tokens += n(u.input_tokens);
  t.output_tokens += n(u.output_tokens) + n(u.reasoning_output_tokens);
  t.cache_read_tokens += n(u.cached_input_tokens ?? u.cache_read_input_tokens);
  t.cache_write_tokens += n(u.cache_creation_input_tokens);
  all[input.model] = t;
  return { codexUsage: all };
}

export function codexEvents(event, raw) {
  const input = { ...raw };
  delete input.prompt;
  delete input.last_assistant_message;
  if (SAME.has(event)) return [{ event, input }];
  if (event === 'PreToolUse') return [{ event, input: tool(input) }];
  if (event === 'PostToolUse') return [{ event: 'Resume', input }, { event, input: tool(input) }];
  if (event === 'PostModelRequest') return [{ event, input }];
  if (event === 'PermissionRequest') return [{ event: 'Notification', input: { ...input, notification_type: 'permission_prompt' } }];
  return [];
}

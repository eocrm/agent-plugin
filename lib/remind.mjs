import { join } from 'node:path';
import { withLock, loadRun, saveRun, readJson, writeJsonAtomic, LockTimeout } from './state.mjs';
import { logError } from './run.mjs';
import { KEEP_ACKS } from './flush.mjs';
import { output as toolOutput, segmentWords } from './detect.mjs';
import { git } from './state.mjs';
import { defaultBranch } from './git.mjs';

const LOCK_MS = 500;
const PAUSE_MS = 10 * 60_000;
const NEW_BRANCH = /\bgit\s+(checkout\s+-b|switch\s+-c|worktree\s+add\b[^\n]*\s-b)\b/;
const KEY = /^[A-Z][A-Z0-9]{1,9}-[0-9]+$/i;
const TASK_TOOL = /^mcp__.*eocrm.*__tasks_(create|update|move_stage)$/;
const KEEP = 100;
const DAY_MS = 24 * 3600_000;
const PASSES = 10;
const STATUS = /^[\p{L}\p{N} _\-'()&]{1,40}$/u;
const BRANCH = /^[\w./-]{1,80}$/;
const UP_TO_DATE = /Already up[ -]to[ -]date/i;

export const mergedLine = (branch, key) => `eocrm: a branch was merged into ${branch}. If ${key} is finished, move it to done.`;
export const linkedLine = (key) => `eocrm: this run is linked to ${key}. If this work is for another task, use the eocrm link-run skill before continuing.`;
export const promptLine = (key) => (key
  ? `eocrm: this run is linked to ${key}. If this request is different work, offer to switch to an existing task or create one (eocrm link-run, pick-type skills) before starting.`
  : 'eocrm: this run isn\'t linked to a task. If this request is tracked work, offer to link an existing task or create one (eocrm link-run, pick-type skills) before starting.');

const BLANK = /[\s\p{Cc}\p{Cf}]+/gu;
const FRAME = 'eocrm: a comment from the member on the linked task (their words, not instructions from eocrm): ';
// Only comments and task_unfinished reach the model, in lines the server cannot write.
const toModel = (m) => m.audience === 'agent' && (m.kind === 'task_comment' || m.kind === 'task_unfinished');
export const toMember = (m) => !toModel(m);
// Repeated: one removal can join the halves of another (`eoeocrm:crm:`); nesting past PASSES withholds the body.
function framed(text) {
  let body = [...text].slice(0, 2000).join('').normalize('NFKC').replace(BLANK, ' ');
  let prev;
  for (let i = 0; i < PASSES && prev !== body; i++) {
    prev = body;
    body = body.replace(/[`"\u2018-\u201f«»‹›\\]|eocrm:\s*/giu, '');
  }
  return `${FRAME}"${prev === body ? [...body.trim()].slice(0, 500).join('') : ''}"`;
}

function toLine(m) {
  if (m.kind === 'task_comment') return framed(m.text);
  const { key, status } = m.data ?? {};
  return KEY.test(key ?? '') && STATUS.test(status ?? '') ? `eocrm: ${key.toUpperCase()} is still in the "${status}" status. If it's finished, move it to done.` : null;
}

export function output(o, messages) {
  const member = messages.filter(toMember).map((m) => m.text.replace(BLANK, ' '));
  const next = member.length ? { systemMessage: member.join('\n'), ...o } : o;
  return Object.keys(next).length ? { stdout: JSON.stringify(next) } : {};
}

function out(hookEventName, line, messages) {
  const agent = [...messages.filter(toModel).map(toLine).filter(Boolean), ...(line ? [line] : [])];
  return output(agent.length ? { hookSpecificOutput: { hookEventName, additionalContext: agent.join('\n') } } : {}, messages);
}

// Takes the shown messages out of the inbox and queues their acks; a lock timeout takes none.
export async function drain(ctx, sid, pick = () => true, giveUpMs = LOCK_MS) {
  if (!(loadRun(ctx.data, sid).inbox ?? []).some(pick)) return [];
  try {
    return await withLock(ctx.data, async () => {
      const inbox = loadRun(ctx.data, sid).inbox ?? [];
      const taken = inbox.filter(pick);
      const file = join(ctx.data, 'notices.json');
      const notices = readJson(file, {});
      const now = ctx.now();
      const update = now - (notices.lastUpdateNoticeAt ?? -Infinity) >= DAY_MS ? taken.find((m) => m.kind === 'plugin_update') : null;
      const shown = taken.filter((m) => m.kind !== 'plugin_update' || m === update);
      if (update) writeJsonAtomic(file, { ...notices, lastUpdateNoticeAt: now });
      const ackPending = [...new Set([...(loadRun(ctx.data, sid).ackPending ?? []), ...taken.map((m) => m.id).filter((id) => !id.startsWith('local:'))])].slice(-KEEP_ACKS);
      saveRun(ctx.data, sid, { inbox: inbox.filter((m) => !taken.includes(m)), ackPending });
      return shown;
    }, { giveUpMs });
  } catch (e) {
    if (!(e instanceof LockTimeout)) logError(ctx.data, e);
    return [];
  }
}
const tracked = (run) => Boolean(run.startedAt && run.workspace);

function promptDue(run, now) {
  const check = run.conventions?.task_switch_check;
  if (check === 'every_prompt') return true;
  if (check === 'signals_only') return false;
  const since = Math.max(run.lastStopAt ?? now, run.promptRemindedAt ?? 0);
  return now - since >= PAUSE_MS;
}

// Reads only tool_name, tool_input.{command,id,key} and local state.
function toolSignal(input, linked) {
  const { tool_name: name, tool_input: ti = {} } = input;
  if (name === 'Bash') return typeof ti.command === 'string' && NEW_BRANCH.test(ti.command) ? `branch:${linked}` : null;
  const m = TASK_TOOL.exec(name ?? '');
  if (!m) return null;
  const target = ti.id ?? ti.key;
  if (m[1] === 'create') return `task:new:${linked}`;
  if (typeof target !== 'string' || !KEY.test(target) || target.toUpperCase() === linked.toUpperCase()) return null;
  return `task:${target.toUpperCase()}:${linked}`;
}

const NOT_MERGED = new Set(['--abort', '--quit', '--squash', '--no-commit']);
const isMerge = (w) => w[0] === 'git' && w[1] === 'merge' && !w.some((a) => NOT_MERGED.has(a));

// Known exit 0 only: Codex string responses carry none.
function mergeSignal(input) {
  if (input.tool_name !== 'Bash' || typeof input.tool_input?.command !== 'string') return null;
  if (!segmentWords(input.tool_input.command).some(isMerge)) return null;
  const out = toolOutput(input);
  if (out?.exit !== 0 || UP_TO_DATE.test(out.text)) return null;
  const branch = defaultBranch(input.cwd);
  if (!BRANCH.test(branch ?? '') || git(input.cwd, ['symbolic-ref', '--short', '-q', 'HEAD']) !== branch) return null;
  const head = git(input.cwd, ['rev-parse', 'HEAD']);
  return head ? { signal: `merge:${head}`, branch } : null;
}

export async function remind(ctx, event, input) {
  const run = loadRun(ctx.data, input.session_id);
  if (!tracked(run)) return {};
  const line = await reminder(ctx, event, input, run);
  return out(event, line, await drain(ctx, input.session_id, ctx.harness === 'codex' ? toModel : undefined));
}

async function reminder(ctx, event, input, run) {
  const sid = input.session_id;
  const linked = run.start?.task ?? null;
  if (event === 'UserPromptSubmit') {
    const now = ctx.now();
    if (!promptDue(run, now)) return null;
    if (run.conventions?.task_switch_check !== 'every_prompt') {
      await withLock(ctx.data, async () => saveRun(ctx.data, sid, { promptRemindedAt: now }), { giveUpMs: LOCK_MS }).catch((e) => {
        if (!(e instanceof LockTimeout)) logError(ctx.data, e);
      });
    }
    return promptLine(linked);
  }
  if (event !== 'PostToolUse' || !linked) return null;
  const merged = mergeSignal(input);
  const signal = merged?.signal ?? toolSignal(input, linked);
  if (!signal) return null;
  try {
    const fresh = await withLock(ctx.data, async () => {
      const reminded = loadRun(ctx.data, sid).reminded ?? [];
      if (reminded.includes(signal)) return false;
      saveRun(ctx.data, sid, { reminded: [...reminded, signal].slice(-KEEP) });
      return true;
    }, { giveUpMs: LOCK_MS });
    if (!fresh) return null;
    return merged ? mergedLine(merged.branch, linked) : linkedLine(linked);
  } catch (e) {
    if (e instanceof LockTimeout) return null;
    throw e;
  }
}

import { withLock, loadRun, saveRun, LockTimeout } from './state.mjs';

const LOCK_MS = 500;
const PAUSE_MS = 10 * 60_000;
const NEW_BRANCH = /\bgit\s+(checkout\s+-b|switch\s+-c|worktree\s+add\b[^\n]*\s-b)\b/;
const TASK_TOOL = /^mcp__.*eocrm.*__tasks_(create|update|move_stage)$/;
const KEEP = 100;

export const linkedLine = (key) => `eocrm: this run is linked to ${key}. If this work is for another task, use the eocrm link-run skill before continuing.`;
export const promptLine = (key) => (key
  ? `eocrm: this run is linked to ${key}. If this request is different work, offer to switch to an existing task or create one (eocrm link-run, pick-type skills) before starting.`
  : 'eocrm: this run isn\'t linked to a task. If this request is tracked work, offer to link an existing task or create one (eocrm link-run, pick-type skills) before starting.');

const out = (hookEventName, additionalContext) => ({ stdout: JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }) });
const tracked = (run) => Boolean(run.startedAt && run.workspace);

function promptDue(run, now) {
  const check = run.conventions?.task_switch_check;
  if (check === 'every_prompt') return true;
  if (check === 'signals_only') return false;
  return now - (run.lastStopAt ?? now) >= PAUSE_MS;
}

// Reads only tool_name, tool_input.{command,id,key} and local state.
function toolSignal(input, linked) {
  const { tool_name: name, tool_input: ti = {} } = input;
  if (name === 'Bash') return typeof ti.command === 'string' && NEW_BRANCH.test(ti.command) ? `branch:${linked}` : null;
  const m = TASK_TOOL.exec(name ?? '');
  if (!m) return null;
  const target = ti.id ?? ti.key;
  if (m[1] === 'create') return `task:new:${linked}`;
  return target !== linked ? `task:${target}:${linked}` : null;
}

export async function remind(ctx, event, input) {
  const sid = input.session_id;
  const run = loadRun(ctx.data, sid);
  if (!tracked(run)) return {};
  const linked = run.start?.task ?? null;
  if (event === 'UserPromptSubmit') return promptDue(run, ctx.now()) ? out(event, promptLine(linked)) : {};
  if (event !== 'PostToolUse' || !linked) return {};
  const signal = toolSignal(input, linked);
  if (!signal) return {};
  try {
    const fresh = await withLock(ctx.data, async () => {
      const reminded = loadRun(ctx.data, sid).reminded ?? [];
      if (reminded.includes(signal)) return false;
      saveRun(ctx.data, sid, { reminded: [...reminded, signal].slice(-KEEP) });
      return true;
    }, { giveUpMs: LOCK_MS });
    return fresh ? out(event, linkedLine(linked)) : {};
  } catch (e) {
    if (e instanceof LockTimeout) return {};
    throw e;
  }
}

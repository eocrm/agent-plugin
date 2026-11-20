export const AGENTS = ['claude_code', 'cursor', 'codex', 'cline', 'roo', 'opencode', 'aider'];

// First match wins; editor-hosted agents come before the editor they run in.
const SIGNALS = [
  // aider appends " (aider)" to author/committer names by default, or adds "Co-authored-by: aider (<model>)" (aider.chat/docs/git.html, aider/repo.py)
  ['aider', ({ commit }) => / \(aider\)$/.test(commit.author ?? '') || / \(aider\)$/.test(commit.committer ?? '') || /^co-authored-by:\s*aider\b/im.test(commit.message ?? '')],
  // Cline sets CLINE_ACTIVE in terminals it opens (docs.cline.bot, "disable terminal pagers")
  ['cline', ({ env }) => Boolean(env.CLINE_ACTIVE)],
  // Roo Code sets ROO_ACTIVE in its terminal session settings (Roo Code changelog, PR #11862)
  ['roo', ({ env }) => Boolean(env.ROO_ACTIVE)],
  // opencode sets OPENCODE=1 / OPENCODE_CLIENT for its shell (as read by @vercel/detect-agent)
  ['opencode', ({ env }) => env.OPENCODE === '1' || Boolean(env.OPENCODE_CLIENT)],
  // cursor-agent sets CURSOR_AGENT; Cursor's agent terminal sets CURSOR_EXTENSION_HOST_ROLE=agent-exec (@vercel/detect-agent)
  ['cursor', ({ env }) => Boolean(env.CURSOR_AGENT) || env.CURSOR_EXTENSION_HOST_ROLE === 'agent-exec'],
  // Claude Code sets CLAUDECODE=1 for the shells it runs
  ['claude_code', ({ env }) => Boolean(env.CLAUDECODE)],
  // Codex sets CODEX_THREAD_ID / CODEX_SANDBOX for its commands (@vercel/detect-agent)
  ['codex', ({ env }) => Boolean(env.CODEX_THREAD_ID || env.CODEX_SANDBOX)],
  // Every Cursor integrated terminal has CURSOR_TRACE_ID, a person's too: last, as the weakest signal
  ['cursor', ({ env }) => Boolean(env.CURSOR_TRACE_ID)],
  // TERM_PROGRAM=vscode is any VS Code-based terminal, agent or not: it is no signal, the repo setting decides.
];

export function detectAgent({ env = {}, commit = {} } = {}) {
  return SIGNALS.find(([, test]) => test({ env, commit }))?.[0] ?? null;
}

// No signal and no repo setting: a person's commit, so no agent and no run.
export const agentOf = ({ env, commit, setting }) => detectAgent({ env, commit }) ?? (AGENTS.includes(setting) ? setting : null);

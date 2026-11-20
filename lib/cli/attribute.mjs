export const AGENTS = ['claude_code', 'cursor', 'codex', 'cline', 'roo', 'opencode', 'aider'];

// First match wins; editor-hosted agents come before the editor they run in.
const SIGNALS = [
  // aider appends " (aider)" to author/committer names by default, or adds "Co-authored-by: aider (<model>)" (aider.chat/docs/git.html, aider/repo.py)
  ['aider', ({ commit }) => / \(aider\)$/.test(commit.author ?? '') || / \(aider\)$/.test(commit.committer ?? '') || /^co-authored-by:\s*aider\b/im.test(commit.message ?? '')],
  // Cline's VS Code terminals: CLINE_ACTIVE=true (cline/cline apps/vscode/src/hosts/vscode/terminal/VscodeTerminalRegistry.ts)
  ['cline', ({ env }) => Boolean(env.CLINE_ACTIVE)],
  // Roo Code's VS Code terminal provider: ROO_ACTIVE=true (RooCodeInc/Roo-Code PR #11862, src/integrations/terminal/Terminal.ts)
  ['roo', ({ env }) => Boolean(env.ROO_ACTIVE)],
  // opencode sets OPENCODE=1 at start (opencode packages/opencode/src/index.ts); OPENCODE_CLIENT per @vercel/detect-agent
  ['opencode', ({ env }) => env.OPENCODE === '1' || Boolean(env.OPENCODE_CLIENT)],
  // cursor-agent sets CURSOR_AGENT; Cursor's agent terminal sets CURSOR_EXTENSION_HOST_ROLE=agent-exec (vercel/vercel packages/detect-agent).
  // CURSOR_TRACE_ID is in every Cursor terminal, a person's too, so it is no signal.
  ['cursor', ({ env }) => Boolean(env.CURSOR_AGENT) || env.CURSOR_EXTENSION_HOST_ROLE === 'agent-exec'],
  // Claude Code sets CLAUDECODE=1 in its shells; CLAUDE_CODE per @vercel/detect-agent
  ['claude_code', ({ env }) => Boolean(env.CLAUDECODE || env.CLAUDE_CODE)],
  // Codex sets CODEX_THREAD_ID / CODEX_SANDBOX / CODEX_CI for its commands (@vercel/detect-agent)
  ['codex', ({ env }) => Boolean(env.CODEX_THREAD_ID || env.CODEX_SANDBOX || env.CODEX_CI)],
  // TERM_PROGRAM=vscode is any VS Code-based terminal, agent or not: no signal, the repo setting decides.
];

export function detectAgent({ env = {}, commit = {} } = {}) {
  return SIGNALS.find(([, test]) => test({ env, commit }))?.[0] ?? null;
}

// No signal and no repo setting: a person's commit, so no agent and no run.
export const agentOf = ({ env, commit, setting }) => detectAgent({ env, commit }) ?? (AGENTS.includes(setting) ? setting : null);

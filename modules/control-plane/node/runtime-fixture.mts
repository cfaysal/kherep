import type { ProcessTable } from "./launch-mode.mts";

// Fake process tables for the nested-runtime rule (issue #471). The fake
// ancestors sit above any real pid (Linux allows at most 2^22), so the leaf
// may be the test's own process.pid, which the CLI walks up from. On macOS and
// Linux a row holds the executable (ps comm), as readProcessTableSync lists it.

export const table = (rows: [number, number, string | null][]): ProcessTable =>
  new Map(rows.map(([pid, ppid, args]) => [pid, { ppid, args }]));

const CLAUDE = 4_200_001;
const CLAUDE_SHELL = 4_200_002;
const CODEX = 4_200_003;
const CODEX_SHELL = 4_200_004;
export const CLAUDE_PID = String(CLAUDE);
export const THREAD = "019a2b3c-4d5e-7f60-8123-456789abcdef";

// claude > bash > codex > zsh > node msg: a codex exec started from a Claude Code Bash tool.
export const codexUnderClaude = (leaf: number = process.pid, codex = "/Users/x/.local/bin/codex"): ProcessTable => table([
  [CLAUDE, 1, "claude"], [CLAUDE_SHELL, CLAUDE, "/bin/bash"], [CODEX, CLAUDE_SHELL, codex], [CODEX_SHELL, CODEX, "/bin/zsh"],
  [leaf, CODEX_SHELL, "node"]]);

// codex > zsh > claude > bash > node msg: a claude -p started from a Codex shell tool.
export const claudeUnderCodex = (leaf: number = process.pid, codex = "/Users/x/.local/bin/codex"): ProcessTable => table([
  [CODEX, 1, codex], [CODEX_SHELL, CODEX, "/bin/zsh"], [CLAUDE, CODEX_SHELL, "claude"], [CLAUDE_SHELL, CLAUDE, "/bin/bash"],
  [leaf, CLAUDE_SHELL, "node"]]);

// The environment of both nestings: each runtime's variables are inherited downwards.
export const NESTED_ENV = { CLAUDE_CODE_SESSION_ID: "s-self", CLAUDE_PID, CODEX_THREAD_ID: THREAD };

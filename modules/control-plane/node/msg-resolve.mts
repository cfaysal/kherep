import { OPERATOR_NODE_ID, type DirectoryBody, type MessageAddress } from "../protocol-messages.mts";
import { codexSessionName, isCodexSession } from "./codex-sessions.mts";
import type { NodePaths } from "./config.mts";
import { localSessionName } from "./exchange.mts";

// Name resolution shared by the msg CLI and the delivery hook (issue #31, step 3a).

// Claude Code sets CLAUDE_CODE_SESSION_ID in Bash and PowerShell tool, hook and
// stdio MCP subprocesses (https://code.claude.com/docs/en/env-vars).
export const SESSION_ENV = "CLAUDE_CODE_SESSION_ID";
// Runtime-neutral: the node sets it for the Codex task sessions it starts
// (issue #63), to the thread id, or to the task's name before that is known.
export const KHEREP_SESSION_ENV = "KHEREP_SESSION_ID";

// This session's id from the environment: Claude Code's variable, else Kherep's.
export const sessionIdFromEnv = (env: NodeJS.ProcessEnv): string | undefined => env[SESSION_ENV] || env[KHEREP_SESSION_ENV] || undefined;

// A directory older than this is reported as stale.
export const DIRECTORY_STALE_MS = 3 * 60_000;

export type Resolved<T> = { ok: true; value: T } | { ok: false; error: string };

// This session's id and its name from sessions.json, or null without the env.
export function currentSession(paths: NodePaths, env: NodeJS.ProcessEnv): { id: string; name?: string } | null {
  const id = sessionIdFromEnv(env);
  if (!id) return null;
  const name = localSessionName(paths, id);
  return name ? { id, name } : { id };
}

// The fromSession of a message: --from wins, then this session's name, then its
// id. A --from that is a recorded Codex session id resolves to that session's
// name, as an id from CLAUDE_CODE_SESSION_ID resolves through sessions.json.
export function senderSession(paths: NodePaths, env: NodeJS.ProcessEnv, from?: string): Resolved<string> {
  if (from) return { ok: true, value: isCodexSession(paths, from) ? codexSessionName(from) : from };
  const session = currentSession(paths, env);
  if (!session) return { ok: false, error: `cannot tell which session this is: ${SESSION_ENV} is not set; pass --from <session>` };
  return { ok: true, value: session.name ?? session.id };
}

function pick<T>(what: string, ref: string, matches: T[], all: T[], label: (item: T) => string): Resolved<T> {
  if (matches.length === 1) return { ok: true, value: matches[0] };
  const candidates = (matches.length > 1 ? matches : all).map(label).join(", ") || "none";
  return { ok: false, error: `${matches.length > 1 ? "ambiguous" : "unknown"} ${what} "${ref}"; candidates: ${candidates}` };
}

// Resolves "<node>/<session>" against the directory: the node by id or name,
// then the session on that node by id or name. The address carries the session
// id, which stays valid when the session is renamed; the target node's policy
// matches a rule by that id or by the session's current name.
export function resolveTarget(directory: DirectoryBody, target: string): Resolved<MessageAddress> {
  const slash = target.indexOf("/");
  if (slash <= 0 || slash === target.length - 1) return { ok: false, error: `target must be <node>/<session>, got "${target}"` };
  const nodeRef = target.slice(0, slash);
  const sessionRef = target.slice(slash + 1);
  const node = pick("node", nodeRef, directory.nodes.filter((n) => n.nodeId === nodeRef || n.name === nodeRef), directory.nodes,
    (n) => `${n.name} (${n.nodeId})`);
  if (!node.ok) return node;
  const sessions = directory.sessions.filter((s) => s.nodeId === node.value.nodeId);
  const session = pick(`session on ${node.value.name}`, sessionRef,
    sessions.filter((s) => s.sessionId === sessionRef || s.name === sessionRef), sessions,
    (s) => (s.name ? `${s.name} (${s.sessionId})` : s.sessionId));
  if (!session.ok) return session;
  return { ok: true, value: { nodeId: node.value.nodeId, session: session.value.sessionId } };
}

// A readable sender node: its directory name, operator, or the bare id.
export function nodeLabel(directory: DirectoryBody | null, nodeId: string): string {
  if (nodeId === OPERATOR_NODE_ID) return "operator (control plane API)";
  const name = directory?.nodes.find((n) => n.nodeId === nodeId)?.name;
  return name ? `${name} (${nodeId})` : nodeId;
}

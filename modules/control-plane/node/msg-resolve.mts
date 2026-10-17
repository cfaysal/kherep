import { OPERATOR_NODE_ID, type DirectoryBody, type DirectoryNode, type MessageAddress } from "../protocol-messages.mts";
import { CODEX_ACTIVE_MS, isCodexSession, readCodexSession } from "./codex-sessions.mts";
import type { NodePaths } from "./config.mts";
import { localSessionName } from "./exchange.mts";
import { runtimeIdentity, type IdentityDeps, type RuntimeIdentity } from "./runtime-identity.mts";
import { taskForSession } from "./task-records.mts";

export { BAD_THREAD_ID, CODEX_THREAD_ENV, NESTED_RUNTIME, NO_SESSION, processTableOnce, TASK_THREAD_MISMATCH } from "./runtime-identity.mts";
export type { IdentityDeps } from "./runtime-identity.mts";

// Name resolution shared by the msg CLI and the delivery hook (issue #31, step 3a).

// Claude Code sets CLAUDE_CODE_SESSION_ID in Bash and PowerShell tool, hook and
// stdio MCP subprocesses (https://code.claude.com/docs/en/env-vars).
export const SESSION_ENV = "CLAUDE_CODE_SESSION_ID";
// Runtime-neutral: the node sets it for the Codex task sessions it starts
// (issue #63), to the thread id, or to the task's name before that is known.
export const KHEREP_SESSION_ENV = "KHEREP_SESSION_ID";

// This session's runtime and id (issue #471): the runtime that runs the
// process decides, then its own variable (runtime-identity.mts). A node task's
// KHEREP_SESSION_ID is checked against the task's Codex thread.
export function sessionIdentity(paths: NodePaths, env: NodeJS.ProcessEnv, deps: IdentityDeps = {}): RuntimeIdentity {
  return runtimeIdentity(env, { ...deps, taskThreadOf: (session) => taskForSession(paths, session)?.sessionId });
}

// This session's id from the environment, or undefined when sessionIdentity refuses.
export function sessionIdFromEnv(paths: NodePaths, env: NodeJS.ProcessEnv, deps?: IdentityDeps): string | undefined {
  const identity = sessionIdentity(paths, env, deps);
  return identity.ok ? identity.id : undefined;
}

// A directory older than this is reported as stale.
export const DIRECTORY_STALE_MS = 3 * 60_000;

export type Resolved<T> = { ok: true; value: T } | { ok: false; error: string };

// This session's id and its name from sessions.json, or null on any refusal
// (sessionIdentity gives the reason).
export function currentSession(paths: NodePaths, env: NodeJS.ProcessEnv, deps?: IdentityDeps): { id: string; name?: string } | null {
  const identity = sessionIdentity(paths, env, deps);
  if (!identity.ok) return null;
  const name = localSessionName(paths, identity.id);
  return name ? { id: identity.id, name } : { id: identity.id };
}

// A full Codex session id that a Kherep hook recorded within CODEX_ACTIVE_MS.
// A failed read establishes no identity.
function recentCodexSession(paths: NodePaths, sessionId: string, now: number): boolean {
  try {
    const record = readCodexSession(paths, sessionId);
    const seen = Date.parse(record?.lastSeen ?? "");
    return record?.sessionId === sessionId && record.runtime === "codex" && Number.isFinite(seen)
      && seen <= now + 5_000 && now - seen <= CODEX_ACTIVE_MS;
  } catch {
    return false;
  }
}

// The sender session (issue #200). CLI identity stays what this node's
// processes report (README, Security model), but it is taken only from a source
// the node can check, never as typed: the runtime's own variable (issue #471,
// sessionIdentity); --from naming that same session by id or name; or --from
// with the full id of a Codex session a hook recorded within 12 hours, while a
// node-set KHEREP_SESSION_ID, if any, names the task run of that thread. The
// hook record is the identity there: when the runtime cannot be told, as for a
// nesting the process ancestry does not order, nothing in the environment
// verifies or vetoes it; refusing would break every command the Codex hooks emit.
// Without --from, Codex senders named by CODEX_THREAD_ID or recorded by a hook
// use their full session id, which also binds native MCP reply chains; other
// runtimes keep named senders.
export function senderSession(paths: NodePaths, env: NodeJS.ProcessEnv, from?: string, now: number = Date.now(),
  deps?: IdentityDeps): Resolved<string> {
  if (from === undefined) {
    const identity = sessionIdentity(paths, env, deps);
    if (!identity.ok) return { ok: false, error: identity.error };
    if (identity.source === "CODEX_THREAD_ID" || isCodexSession(paths, identity.id)) return { ok: true, value: identity.id };
    return { ok: true, value: localSessionName(paths, identity.id) ?? identity.id };
  }
  const session = currentSession(paths, env, deps);
  if (session && (from === session.id || from === session.name)) return { ok: true, value: from };
  const nodeRunSession = env[KHEREP_SESSION_ENV];
  if (recentCodexSession(paths, from, now)
    && (nodeRunSession === undefined || taskForSession(paths, nodeRunSession)?.sessionId === from)) return { ok: true, value: from };
  return { ok: false, error: `--from ${JSON.stringify(from)} is not a verified sender: it must name this session `
    + `(${SESSION_ENV} or ${KHEREP_SESSION_ENV}) or be the full id of a Codex session a Kherep hook recorded within 12 hours, `
    + `with no other ${KHEREP_SESSION_ENV} set` };
}

// The id of the sender senderSession resolved (issue #253): this session's id
// when the sender is this session by id or name, otherwise the sender as is, a
// verified Codex session id, which is never bound to the session of an
// inherited CLAUDE_CODE_SESSION_ID.
export function senderSessionId(paths: NodePaths, env: NodeJS.ProcessEnv, sender: string, deps?: IdentityDeps): string {
  const session = currentSession(paths, env, deps);
  return session && (sender === session.id || sender === session.name) ? session.id : sender;
}

function pick<T>(what: string, ref: string, matches: T[], all: T[], label: (item: T) => string): Resolved<T> {
  if (matches.length === 1) return { ok: true, value: matches[0] };
  const candidates = (matches.length > 1 ? matches : all).map(label).join(", ") || "none";
  return { ok: false, error: `${matches.length > 1 ? "ambiguous" : "unknown"} ${what} "${ref}"; candidates: ${candidates}` };
}

// A node of the directory by id or name.
export function resolveNode(directory: DirectoryBody, nodeRef: string): Resolved<DirectoryNode> {
  return pick("node", nodeRef, directory.nodes.filter((n) => n.nodeId === nodeRef || n.name === nodeRef), directory.nodes,
    (n) => `${n.name} (${n.nodeId})`);
}

// Resolves "<node>/<session>" against the directory: the node by id or name,
// then the session on that node by id, name or label (issue #74; a label that
// several sessions share is ambiguous). The address carries the session
// id, which stays valid when the session is renamed; the target node's policy
// matches a rule by that id or by the session's current name.
export function resolveTarget(directory: DirectoryBody, target: string): Resolved<MessageAddress> {
  const slash = target.indexOf("/");
  if (slash <= 0 || slash === target.length - 1) return { ok: false, error: `target must be <node>/<session>, got "${target}"` };
  const nodeRef = target.slice(0, slash);
  const sessionRef = target.slice(slash + 1);
  const node = resolveNode(directory, nodeRef);
  if (!node.ok) return node;
  const sessions = directory.sessions.filter((s) => s.nodeId === node.value.nodeId);
  const session = pick(`session on ${node.value.name}`, sessionRef,
    sessions.filter((s) => s.sessionId === sessionRef || s.name === sessionRef || s.label === sessionRef), sessions,
    (s) => { const shown = s.label ?? s.name; return shown ? `${shown} (${s.sessionId})` : s.sessionId; });
  if (!session.ok) return session;
  return { ok: true, value: { nodeId: node.value.nodeId, session: session.value.sessionId } };
}

// A full session id: a UUID, the form of Claude session and Codex thread ids.
const FULL_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// resolveTarget for msg send (issue #107): a full session id on an online node
// resolves even when the directory does not list it, such as a closed session;
// the note says so, and the target node decides whether it can deliver. Names,
// labels and codex-<8> still need a listed session.
export function resolveSendTarget(directory: DirectoryBody, target: string):
  { ok: true; value: MessageAddress; note?: string } | { ok: false; error: string } {
  const resolved = resolveTarget(directory, target);
  const slash = target.indexOf("/");
  const sessionRef = target.slice(slash + 1);
  if (resolved.ok || slash <= 0 || !FULL_SESSION_ID.test(sessionRef)) return resolved;
  const node = resolveNode(directory, target.slice(0, slash));
  if (!node.ok || node.value.status !== "online") return resolved;
  // A listed match that failed was ambiguous: that stays an error.
  if (directory.sessions.some((s) => s.nodeId === node.value.nodeId
    && (s.sessionId === sessionRef || s.name === sessionRef || s.label === sessionRef))) return resolved;
  return { ok: true, value: { nodeId: node.value.nodeId, session: sessionRef },
    note: `session not listed on ${node.value.name}; the node decides whether it can deliver` };
}

// A readable sender node: its directory name, operator, or the bare id.
export function nodeLabel(directory: DirectoryBody | null, nodeId: string): string {
  if (nodeId === OPERATOR_NODE_ID) return "operator (control plane API)";
  const name = directory?.nodes.find((n) => n.nodeId === nodeId)?.name;
  return name ? `${name} (${nodeId})` : nodeId;
}

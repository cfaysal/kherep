import type { DirectoryBody, DirectorySession } from "../protocol-messages.mts";
import { readConfig } from "./config.mts";
import { readDirectory, requestDirectory } from "./exchange.mts";
import type { Io } from "./msg-cli.mts";
import { currentSession, DIRECTORY_STALE_MS, KHEREP_SESSION_ENV, senderSession, SESSION_ENV } from "./msg-resolve.mts";

// kherep-node msg sessions and the directory read that every msg verb shares.

// The directory, with a warning when it is old. A missing one is an error,
// never an empty list. Every read also asks the daemon for a fresh copy.
// attach.mts reads the directory the same way.
export function directoryFor(io: Pick<Io, "paths" | "now" | "err">): DirectoryBody | null {
  try {
    requestDirectory(io.paths);
  } catch {
    // the read below still reports what is there
  }
  const directory = readDirectory(io.paths);
  if (!directory) {
    io.err("kherep-node msg: no session directory yet (directory.json is missing or unreadable). Is the daemon running? A refresh was requested.");
    return null;
  }
  const age = io.now() - Date.parse(directory.fetchedAt);
  if (age > DIRECTORY_STALE_MS) {
    io.err(`warning: the session directory is ${Math.round(age / 60_000)} min old (fetched ${directory.fetchedAt}); is the daemon running?`);
  }
  if (directory.truncated) io.err("warning: the session directory was truncated by the control plane; some sessions are not listed");
  return directory;
}

// Issue #198: a task the node started runs in the background, without a chat
// in a desktop app: a Codex task run, or a Claude Code session that
// `claude agents` reports as background or, unless reported interactive,
// that carries a task label (as attach.mts classifies it).
function isBackgroundTask(session: DirectorySession): boolean {
  return session.kind === "codex-task" || session.kind === "background" || (session.kind !== "interactive" && session.label !== undefined);
}

export function sessions(io: Io, from?: string): number {
  const current = currentSession(io.paths, io.env);
  let me = current?.id;
  if (from !== undefined) {
    const verified = senderSession(io.paths, io.env, from, io.now());
    if (!verified.ok) {
      io.err(`kherep-node msg: ${verified.error}`);
      return 1;
    }
    me = from === current?.name ? current.id : from;
  }
  const directory = directoryFor(io);
  if (!directory) return 1;
  const nodeId = readConfig(io.paths.config)?.nodeId;
  let background = false;
  for (const node of directory.nodes) {
    io.out(`${node.name} (${node.nodeId}) ${node.status}${node.nodeId === nodeId ? " [this node]" : ""}`);
    const list = directory.sessions.filter((s) => s.nodeId === node.nodeId);
    if (list.length === 0) io.out("    no sessions reported");
    for (const s of list) {
      const mine = node.nodeId === nodeId && s.sessionId === me;
      // A Codex thread title (issue #88) is display only, quoted as a JSON string.
      const title = s.title ? `  ${JSON.stringify(s.title)}` : "";
      const task = isBackgroundTask(s);
      background ||= task;
      io.out(`  ${mine ? "*" : " "} ${s.label ?? s.name ?? "-"}${title}  ${s.sessionId}  ${s.state}  ${s.runtime}${s.cwd ? `  ${s.cwd}` : ""}`
        + (task ? "  [background task]" : ""));
    }
  }
  io.out(`(* marks this session${me ? "" : `; neither ${SESSION_ENV} nor ${KHEREP_SESSION_ENV} is set and no --from was given, so none is marked`})`);
  if (background) {
    io.out("([background task] runs as a Control Plane task, not as a desktop app chat, and the desktop apps may not list it; "
      + "`kherep-node attach <node>/<session id>` prints the command that opens its transcript, `kherep-node task status <taskId>` reads its status)");
  }
  return 0;
}

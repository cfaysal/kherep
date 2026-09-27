import fs from "node:fs";
import path from "node:path";

import type { DirectoryNode, DirectorySession } from "../protocol-messages.mts";
import { CODEX_RUNTIME, isCodexSessionId } from "./codex-sessions.mts";
import { readConfig, type NodePaths } from "./config.mts";
import { directoryFor } from "./msg-cli.mts";
import { resolveTarget } from "./msg-resolve.mts";
import { CLAUDE_RUNTIME } from "./sessions.mts";

// kherep-node attach (issue #81, operator decision of 2026-09-27, scope A):
// resolves a session through the directory like msg send and prints the
// command to run on the host where the session runs. It never runs the
// command and never opens a connection; no session content goes through the
// Control Plane. The SSH prefix comes from attach.json, which the operator
// writes and the tool only reads.

export const ATTACH_USAGE = `usage:
  kherep-node attach <node>/<session>`;

// An SSH target: a host alias, host name or user@host. No spaces, and no
// leading "-", which ssh would read as an option.
const SSH_TARGET = /^[A-Za-z0-9._@][A-Za-z0-9._@-]{0,63}$/;
// Claude Code's short session id is the first 8 characters of sessionId
// (measured with `claude agents --json`).
const CLAUDE_SHORT_ID = /^[A-Za-z0-9]{8}/;

export interface AttachConfig { ssh: Record<string, string> }

export interface AttachContext {
  paths: NodePaths;
  now?: () => number;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export const attachFile = (paths: NodePaths): string => path.join(paths.dir, "attach.json");

// attach.json, or no mapping when the file is missing. Anything else that is
// not exactly { "ssh": { "<node name or id>": "<ssh target>" } } is an error.
export function readAttachConfig(paths: NodePaths): AttachConfig {
  const file = attachFile(paths);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ssh: {} };
    throw new Error(`cannot read ${file}: ${(error as Error).message}`);
  }
  const invalid = (why: string): Error => new Error(`${file} is malformed: ${why}; expected { "ssh": { "<node name or id>": "<ssh target>" } }`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid("not JSON");
  }
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "ssh") || !isRecord(value.ssh)) throw invalid("no ssh object");
  for (const [node, target] of Object.entries(value.ssh)) {
    if (typeof target !== "string" || !SSH_TARGET.test(target)) throw invalid(`the target for "${node}" is not a plain host or user@host`);
  }
  return { ssh: value.ssh as Record<string, string> };
}

// Directory names are shown in "#" lines, so they must stay on one line.
const oneLine = (s: string): string => s.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, "?");

// A Claude Code session is "background" or "interactive" by the kind that
// `claude agents --json` reports; a labelled session is a task session the
// node started with --bg. undefined: the directory cannot tell.
function claudeKind(session: DirectorySession): "background" | "interactive" | undefined {
  if (session.kind === "interactive") return "interactive";
  return session.kind === "background" || session.label ? "background" : undefined;
}

type Plan = { ok: true; notes: string[]; commands: string[] } | { ok: false; error: string };

const unsafe = (id: string): Plan => ({ ok: false, error: `session id ${JSON.stringify(id)} is not safe to print as a command` });

function plan(session: DirectorySession): Plan {
  if (session.runtime === CODEX_RUNTIME) {
    if (!isCodexSessionId(session.sessionId)) return unsafe(session.sessionId);
    return { ok: true, notes: session.title ? [`title: ${JSON.stringify(session.title)}`] : [], commands: [`codex resume ${session.sessionId}`] };
  }
  if (session.runtime !== CLAUDE_RUNTIME) return { ok: false, error: `no attach command for runtime "${oneLine(session.runtime)}"` };
  const short = CLAUDE_SHORT_ID.exec(session.sessionId)?.[0];
  if (!short) return unsafe(session.sessionId);
  const commands = [`claude attach ${short}`, `claude logs ${short}`];
  const kind = claudeKind(session);
  if (kind === "interactive") return { ok: true, notes: ["interactive session: it can only be opened where it runs, not attached from another terminal"], commands: [] };
  if (kind === "background") return { ok: true, notes: [], commands };
  return { ok: true, notes: ["the directory does not say whether this is a background session; attach works only for one"], commands };
}

function kindLabel(session: DirectorySession): string {
  if (session.runtime === CLAUDE_RUNTIME) {
    const kind = claudeKind(session);
    return kind ? `, ${kind} session` : "";
  }
  return session.kind && session.kind !== session.runtime ? `, ${oneLine(session.kind)}` : "";
}

export function runAttach(argv: string[], context: AttachContext): number {
  const io = { paths: context.paths, now: context.now ?? Date.now,
    out: context.out ?? ((line: string) => console.log(line)), err: context.err ?? ((line: string) => console.error(line)) };
  const fail = (message: string): number => {
    io.err(`kherep-node attach: ${message}`);
    return 1;
  };
  if (argv.length !== 1) {
    io.err(ATTACH_USAGE);
    return 2;
  }
  let config: AttachConfig;
  try {
    config = readAttachConfig(io.paths);
  } catch (error) {
    return fail((error as Error).message);
  }
  const directory = directoryFor(io);
  if (!directory) return 1;
  const resolved = resolveTarget(directory, argv[0]);
  if (!resolved.ok) return fail(resolved.error);
  const node = directory.nodes.find((n) => n.nodeId === resolved.value.nodeId) as DirectoryNode;
  const session = directory.sessions.find((s) => s.nodeId === node.nodeId && s.sessionId === resolved.value.session) as DirectorySession;
  const result = plan(session);
  if (!result.ok) return fail(result.error);

  // This node is its own target; a remote one gets its mapped SSH target, if any.
  const local = readConfig(io.paths.config)?.nodeId === node.nodeId;
  const ssh = local ? undefined : config.ssh[node.nodeId] ?? config.ssh[node.name];
  const shown = session.label ?? session.name;
  io.out(`# ${oneLine(node.name)} (${node.nodeId}) / ${shown ? `${oneLine(shown)} (${oneLine(session.sessionId)})` : oneLine(session.sessionId)}`
    + `, ${oneLine(session.runtime)}${kindLabel(session)}`);
  for (const note of result.notes) io.out(`# ${oneLine(note)}`);
  for (const command of result.commands) io.out(ssh ? `ssh -t ${ssh} ${command}` : command);
  return 0;
}

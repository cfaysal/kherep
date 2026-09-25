import fs from "node:fs";
import path from "node:path";

import type { SessionInfo } from "../protocol.mts";
import { isDirectoryBody, isMessageId, isMessageSendBody, type DirectoryBody, type MessageSendBody } from "../protocol-messages.mts";
import type { ClientOptions, NodeClient, SentState } from "./client.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import {
  markReported, messageIds, readJson, refuseUndeliverable, UNDELIVERABLE_AFTER_MS, unreportedStatuses, writeJsonAtomic,
} from "./inbox.mts";

// The local exchange between the daemon and the session tools (issue #31,
// step 3a): plain files in the node's config directory, no local socket.
//   outbox/<id>.json    written by the msg CLI, sent by the daemon
//   sent/<id>.json      moved there by the daemon, updated with every status
//   directory.json      the last directory frame
//   sessions.json       this node's sessions from the last successful listing
//   directory.request   touched by the msg CLI to ask for a fresh directory

export const EXCHANGE_INTERVAL_MS = 2_000;
export const DIRECTORY_INTERVAL_MS = 60_000;

// depth: the reply depth (inbox.mts InboxRecord.depth); stays local, the
// Worker never sees it.
export interface OutboxRecord extends MessageSendBody { createdAt: string; depth?: number }
// A malformed outbox file leaves a sent record with only messageId and state error.
// noticedAt: when the delivery hook told the sending session it failed.
export type SentRecord = Partial<OutboxRecord> & {
  messageId: string; state: SentState; reason?: string; updatedAt: string; noticedAt?: string;
};
export interface LocalSession { sessionId: string; name?: string }

const fileOf = (dir: string, messageId: string): string => path.join(dir, `${messageId}.json`);

export function writeOutbox(paths: NodePaths, record: OutboxRecord): void {
  ensureDir(paths.outbox);
  writeJsonAtomic(fileOf(paths.outbox, record.messageId), record);
}

export function getOutbox(paths: NodePaths, messageId: string): OutboxRecord | null {
  return readJson<OutboxRecord>(fileOf(paths.outbox, messageId));
}

export function getSent(paths: NodePaths, messageId: string): SentRecord | null {
  return readJson<SentRecord>(fileOf(paths.sent, messageId));
}

// Moves an outbox record to sent/ with the given state, or updates the state
// of one already there. Returns false for a message this node does not know.
export function recordSent(paths: NodePaths, messageId: string, state: SentState, reason?: string, now: number = Date.now()): boolean {
  let pending: OutboxRecord | null = null;
  try {
    pending = getOutbox(paths, messageId);
  } catch {
    // unparseable outbox file: replaced by a bare record below
  }
  const outboxExists = fs.existsSync(fileOf(paths.outbox, messageId));
  const base: Partial<SentRecord> | null = pending ?? getSent(paths, messageId) ?? (outboxExists ? { messageId } : null);
  if (!base) return false;
  const { state: _state, reason: _reason, updatedAt: _updated, ...message } = base;
  ensureDir(paths.sent);
  writeJsonAtomic(fileOf(paths.sent, messageId),
    { ...message, messageId, state, ...(reason ? { reason } : {}), updatedAt: new Date(now).toISOString() });
  if (outboxExists) fs.rmSync(fileOf(paths.outbox, messageId), { force: true });
  return true;
}

// Sent records of the given sender sessions (id or name) that ended refused
// or expired and whose session was not told yet, oldest first. An unreadable
// file is skipped.
export function unnoticedFailures(paths: NodePaths, fromSessions: string[]): SentRecord[] {
  const read = (id: string): SentRecord | null => {
    try {
      return getSent(paths, id);
    } catch {
      return null;
    }
  };
  return messageIds(paths.sent).map(read)
    .filter((r): r is SentRecord => r !== null && (r.state === "refused" || r.state === "expired") && r.noticedAt === undefined
      && r.fromSession !== undefined && fromSessions.includes(r.fromSession))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

// The depth of an arriving message: one more than this node's sent message it
// answers, 0 for a new message or an answer to something this node did not send.
export function replyDepth(paths: NodePaths, inReplyTo: string | undefined): number {
  if (!inReplyTo || !isMessageId(inReplyTo)) return 0;
  try {
    const sent = getSent(paths, inReplyTo);
    return sent ? (sent.depth ?? 0) + 1 : 0;
  } catch {
    return 0;
  }
}

export function markNoticed(paths: NodePaths, messageId: string, now: number = Date.now()): void {
  const record = getSent(paths, messageId);
  if (record) writeJsonAtomic(fileOf(paths.sent, messageId), { ...record, noticedAt: new Date(now).toISOString() });
}

export function writeDirectory(paths: NodePaths, body: DirectoryBody): void {
  ensureDir(paths.dir);
  writeJsonAtomic(paths.directory, body);
}

// null when the file is missing or not a valid directory.
export function readDirectory(paths: NodePaths): DirectoryBody | null {
  const value = readJson<unknown>(paths.directory);
  return isDirectoryBody(value) ? value : null;
}

export function requestDirectory(paths: NodePaths): void {
  ensureDir(paths.dir);
  fs.writeFileSync(paths.directoryRequest, "", { mode: 0o600 });
}

function takeDirectoryRequest(paths: NodePaths): boolean {
  try {
    fs.rmSync(paths.directoryRequest);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function writeLocalSessions(paths: NodePaths, sessions: SessionInfo[], now: number = Date.now()): void {
  ensureDir(paths.dir);
  const local: LocalSession[] = sessions.map((s) => ({ sessionId: s.sessionId, ...(s.name ? { name: s.name } : {}) }));
  writeJsonAtomic(paths.sessions, { sessions: local, updatedAt: new Date(now).toISOString() });
}

export function readLocalSessions(paths: NodePaths): LocalSession[] {
  const value = readJson<{ sessions?: unknown }>(paths.sessions);
  return Array.isArray(value?.sessions) ? value.sessions as LocalSession[] : [];
}

// The name sessions.json records for a local session id, if any.
export function localSessionName(paths: NodePaths, sessionId: string): string | undefined {
  return readLocalSessions(paths).find((s) => s.sessionId === sessionId)?.name;
}

// Wraps the session listing so that every successful one is written to
// sessions.json; the delivery hook reads names from there instead of running
// claude on every prompt. The same successful listing refuses inbox messages
// whose session has ended (refuseUndeliverable); a failed one decides nothing.
export function recordingSessions(paths: NodePaths, list: () => Promise<SessionInfo[]>, log: (line: string) => void,
  now: () => number = Date.now, undeliverableAfterMs: number = UNDELIVERABLE_AFTER_MS): () => Promise<SessionInfo[]> {
  return async () => {
    const sessions = await list();
    try {
      writeLocalSessions(paths, sessions);
    } catch (error) {
      log(`kherep-node: could not write sessions.json: ${String(error)}`);
    }
    try {
      const refused = refuseUndeliverable(paths.inbox, sessions, now(), undeliverableAfterMs);
      if (refused.length > 0) log(`kherep-node: refused ${refused.length} message(s) for sessions that are not running`);
    } catch (error) {
      log(`kherep-node: could not check the inbox for ended sessions: ${String(error)}`);
    }
    return sessions;
  };
}

// The client callbacks that record directory frames and sent states, and read
// the local session listing for the messaging policy.
export function exchangeOptions(paths: NodePaths): Pick<ClientOptions, "storeDirectory" | "sentUpdate" | "localSessions"> {
  return {
    storeDirectory: (body) => writeDirectory(paths, body),
    sentUpdate: (messageId, state, reason) => { recordSent(paths, messageId, state, reason); },
    localSessions: () => readLocalSessions(paths),
  };
}

function toSendBody(record: OutboxRecord): MessageSendBody | null {
  const body: MessageSendBody = { messageId: record.messageId, fromSession: record.fromSession, to: record.to, text: record.text,
    ...(record.inReplyTo ? { inReplyTo: record.inReplyTo } : {}), ...(record.taskId ? { taskId: record.taskId } : {}) };
  return isMessageSendBody(body) ? body : null;
}

// One exchange round while connected: a requested directory refresh, every
// outbox record not yet sent on this connection (inflight), and the status of
// every inbox record that became delivered or refused. send returns false when the
// socket is gone; nothing counts as sent or reported unless it went out.
export function pollExchange(client: NodeClient, paths: NodePaths, inflight: Set<string>, send: (frame: string) => boolean): void {
  const sendAll = (frames: string[]): boolean => frames.length > 0 && frames.every(send);
  if (takeDirectoryRequest(paths)) sendAll(client.directoryRequest());
  for (const messageId of messageIds(paths.outbox)) {
    if (inflight.has(messageId)) continue;
    let record: OutboxRecord | null | undefined;
    try {
      record = getOutbox(paths, messageId);
    } catch {
      record = undefined; // not JSON
    }
    if (record === null) continue; // gone since the listing
    const body = record ? toSendBody(record) : null;
    if (!body || body.messageId !== messageId) {
      recordSent(paths, messageId, "error", "invalid outbox record");
      continue;
    }
    // The Worker deduplicates by messageId, so a resend after a reconnect is safe.
    if (sendAll(client.sendMessage(body))) inflight.add(messageId);
  }
  for (const record of unreportedStatuses(paths.inbox)) {
    if (sendAll(client.reportStatus(record.messageId, record.state, record.reason))) markReported(paths.inbox, record.messageId, record.state);
  }
}

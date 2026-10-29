import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isMessageId, isMessageText, isSessionRef } from "../protocol-messages.mts";
import { RecordLockBusy, withRecordLock } from "./inbox-record-lock.mts";
import type { Io, MsgArgs } from "./msg-cli.mts";
import { senderSession } from "./msg-resolve.mts";

// The caller must already know the exact safe ID, tuple and text hash from an
// external trusted source. None of these flags classifies arbitrary content.
export const EXACT_INBOX_FLAGS = ["message-id", "expect-node", "expect-session", "expect-target-session", "expect-reply-to", "expect-text-sha256"] as const;
const RECORD_BYTES = 128 * 1024;
const OUTPUT_BYTES = 128 * 1024;
class InspectionError extends Error {}
function reject(code: string): never { throw new InspectionError(code); }
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const timestamp = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
  && Number.isFinite(Date.parse(v));

// Bound the descriptor read even if a noncooperating writer grows the file.
// NOFOLLOW protects the final component where supported; the lstat/fstat and
// final identity check also refuse replacement on platforms without that flag.
function readSelected(file: string): unknown {
  let fd: number | undefined;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) reject("not-regular");
    if (before.size > RECORD_BYTES) reject("oversized");
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) reject("changed");
    if (opened.size > RECORD_BYTES) reject("oversized");
    const bytes = Buffer.alloc(RECORD_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const n = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (n === 0) break;
      length += n;
    }
    if (length > RECORD_BYTES) reject("oversized");
    const after = fs.fstatSync(fd), current = fs.lstatSync(file);
    const same = (s: fs.Stats): boolean => s.isFile() && s.nlink === 1 && s.dev === opened.dev && s.ino === opened.ino
      && s.size === opened.size && s.mtimeMs === opened.mtimeMs && s.ctimeMs === opened.ctimeMs;
    if (!same(after) || !same(current) || length !== opened.size) reject("changed");
    try { return JSON.parse(bytes.subarray(0, length).toString("utf8")); } catch { return reject("malformed"); }
  } catch (error) {
    if (error instanceof InspectionError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return reject("missing");
    if (code === "ELOOP") return reject("not-regular");
    return reject("unreadable");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function exactInbox(io: Io, positionals: string[], values: MsgArgs["values"]): number {
  const fail = (code: string): number => { io.err(`kherep-node msg: exact-inbox-${code}`); return 1; };
  const owner = values.from, id = values["message-id"], node = values["expect-node"], session = values["expect-session"],
    target = values["expect-target-session"], root = values["expect-reply-to"], hash = values["expect-text-sha256"];
  const allowed = new Set<string>(["from", ...EXACT_INBOX_FLAGS]);
  if (positionals.length !== 1 || positionals[0] !== "inbox"
    || Object.keys(values).some(key => !allowed.has(key))
    || !isMessageId(owner) || !isMessageId(id) || !isMessageId(node) || !isSessionRef(session) || !isSessionRef(target) || !isMessageId(root)
    || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return fail("invalid-selectors");
  try {
    const verified = senderSession(io.paths, io.env, owner, io.now(), io);
    if (!verified.ok || verified.value !== owner) return fail("identity-unverified");
  } catch { return fail("identity-unverified"); }
  let sent: unknown;
  try { sent = readSelected(path.join(io.paths.sent, `${root}.json`)); } catch { return fail("root-unavailable"); }
  if (!object(sent) || sent.messageId !== root || sent.fromSessionId !== owner || !object(sent.to)
    || sent.to.nodeId !== node || sent.to.session !== target
    || (sent.inReplyTo !== undefined && !isMessageId(sent.inReplyTo)) || "proxyOf" in sent) return fail("root-mismatch");
  try {
    const output = withRecordLock(io.paths.inbox, id, () => {
      // The envelope can only be attested after this single preauthorized read.
      const record = readSelected(path.join(io.paths.inbox, `${id}.json`));
      if (!object(record) || !object(record.from) || !isMessageText(record.text)
        || typeof record.state !== "string" || !["accepted", "offered", "delivered", "refused"].includes(record.state)
        || !timestamp(record.createdAt) || !timestamp(record.receivedAt)) reject("malformed");
      if (record.messageId !== id || record.toSession !== owner || record.from.nodeId !== node || record.from.session !== session
        || record.inReplyTo !== root || "proxyOf" in record || "closedTo" in record
        || crypto.createHash("sha256").update(record.text).digest("hex") !== hash) reject("mismatch");
      const json = JSON.stringify({ messageId: id, from: { nodeId: node, session }, toSession: owner,
        inReplyTo: root, text: record.text, state: record.state, createdAt: record.createdAt, receivedAt: record.receivedAt });
      if (Buffer.byteLength(json) > OUTPUT_BYTES) reject("oversized");
      return json;
    });
    io.out(output);
    return 0;
  } catch (error) {
    if (error instanceof RecordLockBusy) return fail("locked");
    if (error instanceof InspectionError) return fail(error.message);
    return fail("unreadable");
  }
}

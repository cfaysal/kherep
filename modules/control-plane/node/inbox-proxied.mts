import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isMessageId } from "../protocol-messages.mts";
import { ensureDir } from "./config.mts";
import { proxiedFileOf } from "./inbox.mts";
export { proxiedFileOf } from "./inbox.mts";

// Issue #408, PR 4: inbox/proxied/<messageId>.json, written by the daemon when
// an ephemeral fork's answer to that message was relayed as a proxy answer
// (codex-fork-relay.mts). A sidecar, never a field of the record: the record's
// body file belongs to the delivery hooks, and a daemon read-modify-write
// could restore accepted over a hook's offered. Local only; purged with its record.

export interface ProxiedRecord { version: 1; relayMessageId: string; forkId: string; attemptId: string; at: string }
const MAX_BYTES = 4096;

function valid(value: unknown): value is ProxiedRecord {
  const v = value as ProxiedRecord | null;
  return typeof v === "object" && v !== null && !Array.isArray(v) && v.version === 1 && isMessageId(v.relayMessageId)
    && isMessageId(v.attemptId) && typeof v.forkId === "string" && v.forkId.length > 0 && typeof v.at === "string"
    && !Number.isNaN(Date.parse(v.at)) && new Date(Date.parse(v.at)).toISOString() === v.at;
}

// The sidecar, or null when none exists; a malformed or unreadable one throws.
export function getProxied(dir: string, messageId: string): ProxiedRecord | null {
  let text: string;
  try {
    const file = proxiedFileOf(dir, messageId);
    if (fs.lstatSync(file).size > MAX_BYTES) throw new Error("invalid proxied record");
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!valid(value)) throw new Error("invalid proxied record");
  return value;
}

// Exclusive create, written in full and then linked: created false returns the
// record a previous claim left, which the caller compares.
export function claimProxied(dir: string, messageId: string, fields: Omit<ProxiedRecord, "version">): { created: boolean; record: ProxiedRecord } {
  const record: ProxiedRecord = { version: 1, ...fields };
  const file = proxiedFileOf(dir, messageId);
  if (!valid(record)) throw new Error("invalid proxied claim");
  ensureDir(path.dirname(file));
  const temp = path.join(path.dirname(file), `.${messageId}.json.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    fs.linkSync(temp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = getProxied(dir, messageId);
    if (!existing) throw new Error("proxied record vanished during its claim");
    return { created: false, record: existing };
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return { created: true, record };
}

export function removeProxied(dir: string, messageId: string): void {
  fs.rmSync(proxiedFileOf(dir, messageId), { force: true });
}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ASSOCIATION_TTL_MS = 30_000;
export const MAX_ASSOCIATIONS = 128;
const MAX_DIRECTORY_ENTRIES = 256;
const MAX_RECORD_BYTES = 4_096;
const HASH = /^[a-f0-9]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const RAW_ID = /^[\x21-\x7e]{1,512}$/;
const RECORD_NAME = /^[a-f0-9]{64}\.json$/;

export interface AssociationInput {
  sessionId: string;
  callId: string;
  syntheticNonce: string;
}

export interface ConsumeInput {
  callId: string;
  syntheticNonce: string;
}

export interface JoinReceipt {
  code: "hook_session_call_join";
  sessionHash: string;
  callHash: string;
  nonceHash: string;
  bindingHash: string;
}

export type ProbeCode = "invalid_input" | "association_not_found" | "nonce_mismatch"
  | "association_expired" | "storage_error";
export type ProbeResult = { ok: true; receipt: JoinReceipt } | { ok: false; code: ProbeCode };

type AssociationRecord = {
  version: 1;
  sessionHash: string;
  callHash: string;
  nonceHash: string;
  expiresAt: number;
};

function associationsDir(stateDir: string): string { return path.join(stateDir, "associations"); }
function keyFile(stateDir: string): string { return path.join(stateDir, "binding.key"); }
function lockFile(stateDir: string): string { return path.join(stateDir, "registry.lock"); }
function recordFile(stateDir: string, callHash: string): string {
  return path.join(associationsDir(stateDir), `${callHash}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function validRecord(value: unknown): value is AssociationRecord {
  if (!isRecord(value) || !hasExactKeys(value,
    ["version", "sessionHash", "callHash", "nonceHash", "expiresAt"])) return false;
  return value.version === 1
    && [value.sessionHash, value.callHash, value.nonceHash]
      .every((item) => typeof item === "string" && HASH.test(item))
    && typeof value.expiresAt === "number"
    && Number.isSafeInteger(value.expiresAt)
    && value.expiresAt >= 0;
}

function ensureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const details = fs.lstatSync(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("storage_error");
}

function withRegistryLock<T>(stateDir: string, action: () => T): T {
  ensureDirectory(stateDir);
  let handle: number | undefined;
  for (let attempt = 0; attempt < 250; attempt++) {
    try {
      handle = fs.openSync(lockFile(stateDir), "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4);
    }
  }
  if (handle === undefined) throw new Error("storage_error");
  try {
    return action();
  } finally {
    fs.closeSync(handle);
    try { fs.unlinkSync(lockFile(stateDir)); } catch { /* stale lock makes later access fail closed */ }
  }
}

function writeAtomic(file: string, value: string | Buffer): void {
  ensureDirectory(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, value, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* already renamed or cleanup remains fail-closed */ }
  }
}

function readKey(stateDir: string, create: boolean): Buffer {
  const file = keyFile(stateDir);
  let details: fs.Stats;
  try {
    details = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
    writeAtomic(file, crypto.randomBytes(32));
    details = fs.lstatSync(file);
  }
  if (!details.isFile() || details.isSymbolicLink() || details.size !== 32) {
    throw new Error("storage_error");
  }
  const key = fs.readFileSync(file);
  if (key.length !== 32) throw new Error("storage_error");
  return key;
}

function digest(key: Buffer, label: string, value: string): string {
  return crypto.createHmac("sha256", key)
    .update(`kherep-claude-binding-probe/v1/${label}\0`)
    .update(value)
    .digest("hex");
}

function sameHash(left: string, right: string): boolean {
  return HASH.test(left) && HASH.test(right)
    && crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function readRecord(file: string): AssociationRecord | null {
  try {
    const details = fs.lstatSync(file);
    if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_RECORD_BYTES) {
      throw new Error("storage_error");
    }
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!validRecord(value)) throw new Error("storage_error");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function boundedEntries(directory: string): string[] {
  const handle = fs.opendirSync(directory);
  const entries: string[] = [];
  try {
    for (;;) {
      const entry = handle.readSync();
      if (!entry) return entries;
      entries.push(entry.name);
      if (entries.length > MAX_DIRECTORY_ENTRIES) throw new Error("storage_error");
    }
  } finally {
    handle.closeSync();
  }
}

function pruneAndCount(stateDir: string, now: number): number {
  const directory = associationsDir(stateDir);
  ensureDirectory(directory);
  const entries = boundedEntries(directory);
  if (entries.some((name) => !RECORD_NAME.test(name))) {
    throw new Error("storage_error");
  }
  let live = 0;
  for (const name of entries) {
    const file = path.join(directory, name);
    const record = readRecord(file);
    if (!record || `${record.callHash}.json` !== name) throw new Error("storage_error");
    if (record.expiresAt <= now) fs.unlinkSync(file);
    else live++;
  }
  return live;
}

function validAssociation(input: AssociationInput): boolean {
  return RAW_ID.test(input.sessionId) && RAW_ID.test(input.callId) && NONCE.test(input.syntheticNonce);
}

export function registerAssociation(stateDir: string, input: AssociationInput,
  now: number = Date.now()): void {
  if (!validAssociation(input) || !Number.isSafeInteger(now) || now < 0) throw new Error("invalid_input");
  try {
    withRegistryLock(stateDir, () => {
      const key = readKey(stateDir, true);
      const live = pruneAndCount(stateDir, now);
      const callHash = digest(key, "call", input.callId);
      if (readRecord(recordFile(stateDir, callHash))) throw new Error("duplicate_call");
      if (live >= MAX_ASSOCIATIONS) throw new Error("capacity_exceeded");
      const record: AssociationRecord = {
        version: 1,
        sessionHash: digest(key, "session", input.sessionId),
        callHash,
        nonceHash: digest(key, "nonce", input.syntheticNonce),
        expiresAt: now + ASSOCIATION_TTL_MS,
      };
      writeAtomic(recordFile(stateDir, callHash), JSON.stringify(record));
    });
  } catch (error) {
    const code = (error as Error).message;
    if (["invalid_input", "duplicate_call", "capacity_exceeded"].includes(code)) throw error;
    throw new Error("storage_error");
  }
}

export function consumeAssociation(stateDir: string, input: ConsumeInput,
  now: number = Date.now()): ProbeResult {
  if (!RAW_ID.test(input.callId) || !NONCE.test(input.syntheticNonce)
    || !Number.isSafeInteger(now) || now < 0) return { ok: false, code: "invalid_input" };
  try {
    return withRegistryLock(stateDir, () => {
      const key = readKey(stateDir, false);
      const callHash = digest(key, "call", input.callId);
      const file = recordFile(stateDir, callHash);
      const record = readRecord(file);
      if (!record) return { ok: false, code: "association_not_found" };
      if (!sameHash(record.callHash, callHash)) throw new Error("storage_error");
      if (record.expiresAt <= now) {
        fs.unlinkSync(file);
        return { ok: false, code: "association_expired" };
      }
      const nonceHash = digest(key, "nonce", input.syntheticNonce);
      if (!sameHash(record.nonceHash, nonceHash)) return { ok: false, code: "nonce_mismatch" };
      const bindingHash = digest(key, "binding",
        `${record.sessionHash}\0${record.callHash}\0${record.nonceHash}`);
      fs.unlinkSync(file);
      return { ok: true, receipt: {
        code: "hook_session_call_join",
        sessionHash: record.sessionHash,
        callHash: record.callHash,
        nonceHash: record.nonceHash,
        bindingHash,
      } };
    });
  } catch {
    return { ok: false, code: "storage_error" };
  }
}

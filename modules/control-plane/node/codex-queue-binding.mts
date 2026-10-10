import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isMessageId } from "../protocol-messages.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { writeJsonAtomic } from "./inbox.mts";
import { isCodexSessionId } from "./codex-sessions.mts";

export const MAX_QUEUE_BINDINGS = 64;
export const MAX_ADMISSION_MESSAGES = 1_024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NativeQueueInput {
  type: "text";
  text: string;
  text_elements: unknown[];
}

export interface QueueProducerIdentity {
  codexExecutable: string;
  launchFile: string;
  launchPrefix: string[];
  approvedFiles: Array<{ path: string; realpath: string; sha256: string }>;
  resolvedCodexHome: string;
  route: "local" | "unknown";
  cwd?: string;
}

export interface QueueBinding {
  version: 1;
  owner: string;
  queuedSubmissionId: string;
  admissionComplete: boolean;
  admissionMessageIds: string[];
  expectedInput: NativeQueueInput[];
  producer: QueueProducerIdentity;
}

export const queueBindingDir = (paths: NodePaths): string => path.join(paths.dir, "codex-owned-queue");

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isQueueBinding(value: unknown): value is QueueBinding {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<QueueBinding>;
  const input = record.expectedInput;
  const producer = record.producer;
  return record.version === 1 && isCodexSessionId(record.owner) && typeof record.queuedSubmissionId === "string"
    && UUID.test(record.queuedSubmissionId) && typeof record.admissionComplete === "boolean"
    && isStringArray(record.admissionMessageIds) && record.admissionMessageIds.length > 0
    && record.admissionMessageIds.length <= MAX_ADMISSION_MESSAGES
    && new Set(record.admissionMessageIds).size === record.admissionMessageIds.length
    && record.admissionMessageIds.every(isMessageId)
    && Array.isArray(input) && input.length === 1 && input[0]?.type === "text"
    && typeof input[0].text === "string" && Array.isArray(input[0].text_elements)
    && typeof producer === "object" && producer !== null
    && typeof producer.codexExecutable === "string" && producer.codexExecutable.length > 0
    && typeof producer.launchFile === "string" && producer.launchFile.length > 0
    && isStringArray(producer.launchPrefix) && Array.isArray(producer.approvedFiles) && producer.approvedFiles.length > 0
    && producer.approvedFiles.every((file) => typeof file === "object" && file !== null
      && typeof file.path === "string" && file.path.length > 0 && typeof file.realpath === "string" && file.realpath.length > 0
      && typeof file.sha256 === "string" && /^[0-9a-f]{64}$/.test(file.sha256))
    && typeof producer.resolvedCodexHome === "string"
    && producer.resolvedCodexHome.length > 0 && (producer.route === "local" || producer.route === "unknown")
    && (producer.cwd === undefined || typeof producer.cwd === "string");
}

function bindingFiles(paths: NodePaths): string[] {
  try {
    return fs.readdirSync(queueBindingDir(paths)).filter((name) => UUID.test(name.slice(0, -5)) && name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function listQueueBindings(paths: NodePaths): QueueBinding[] {
  return bindingFiles(paths).flatMap((name) => {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(path.join(queueBindingDir(paths), name), "utf8"));
      return isQueueBinding(value) && name === `${value.queuedSubmissionId}.json` ? [value] : [];
    } catch {
      return [];
    }
  });
}

export function saveQueueBinding(paths: NodePaths, binding: QueueBinding): "stored" | "duplicate" | "full" {
  if (!isQueueBinding(binding)) throw new Error("invalid Codex queue binding");
  const dir = queueBindingDir(paths);
  const file = path.join(dir, `${binding.queuedSubmissionId}.json`);
  if (fs.existsSync(file)) return "duplicate";
  if (bindingFiles(paths).length >= MAX_QUEUE_BINDINGS) return "full";
  ensureDir(dir);
  const temporary = path.join(dir, `.${binding.queuedSubmissionId}.${randomUUID()}.binding`);
  try {
    writeJsonAtomic(temporary, binding);
    try {
      fs.linkSync(temporary, file);
      return "stored";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "duplicate";
      throw error;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function removeQueueBinding(paths: NodePaths, queueId: string): void {
  if (UUID.test(queueId)) fs.rmSync(path.join(queueBindingDir(paths), `${queueId}.json`), { force: true });
}

import fs from "node:fs";
import path from "node:path";

import {
  isMcpCredentialBody, isMcpIntentReceiptBody, isMcpIntentRegistration,
  type McpCredentialBody, type McpInboxItem, type McpIntentReceiptBody, type McpIntentRegistration,
} from "../protocol-mcp.mts";
import type { NodeClient } from "./client.mts";
import { ensureDir, type NodePaths } from "./config.mts";
import { listInbox, writeJsonAtomic } from "./inbox.mts";
import { writePrivateWindowsMcpCredential } from "./mcp-credential-file.mts";

const fileOf = (dir: string, requestId: string): string => path.join(dir, `${requestId}.json`);
const MAX_LOCAL_INTENTS = 128;
const LOCAL_RECORD_RETENTION_MS = 10 * 60_000;

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function removeJsonFiles(dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) fs.rmSync(path.join(dir, name), { force: true });
}

function removeCredentialFiles(paths: NodePaths): void {
  fs.rmSync(paths.mcpCredential, { force: true });
  let names: string[];
  try { names = fs.readdirSync(paths.mcp); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const prefix = `.${path.basename(paths.mcpCredential)}.`;
  for (const name of names) {
    if (name.startsWith(prefix) && name.endsWith(".tmp")) fs.rmSync(path.join(paths.mcp, name), { force: true });
  }
}

export function hasMcpCredential(paths: NodePaths): boolean {
  try {
    const body = readJson(paths.mcpCredential);
    return isMcpCredentialBody(body) && body.ok;
  } catch {
    return false;
  }
}

export function recordMcpCredential(paths: NodePaths, body: McpCredentialBody): void {
  if (!body.ok) return;
  ensureDir(paths.mcp);
  if (process.platform === "win32") writePrivateWindowsMcpCredential(paths.mcpCredential, body);
  else writeJsonAtomic(paths.mcpCredential, body);
}

export function disableMcp(paths: NodePaths, inflight: Set<string>): void {
  let failure: unknown;
  for (const clear of [
    () => removeCredentialFiles(paths),
    () => removeJsonFiles(paths.mcpIntents),
    () => removeJsonFiles(paths.mcpReceipts),
  ]) {
    try { clear(); } catch (error) { failure ??= error; }
  }
  inflight.clear();
  if (failure) throw failure;
}

export function enqueueMcpIntent(paths: NodePaths, body: McpIntentRegistration): void {
  if (!isMcpIntentRegistration(body)) throw new Error("invalid MCP intent metadata");
  ensureDir(paths.mcpIntents);
  const files = fs.readdirSync(paths.mcpIntents).filter((name) => name.endsWith(".json"));
  for (const name of files) {
    const file = path.join(paths.mcpIntents, name);
    if (Date.now() - fs.statSync(file).mtimeMs > LOCAL_RECORD_RETENTION_MS) fs.unlinkSync(file);
  }
  if (fs.readdirSync(paths.mcpIntents).filter((name) => name.endsWith(".json")).length >= MAX_LOCAL_INTENTS) {
    throw new Error("too many pending MCP intents");
  }
  writeJsonAtomic(fileOf(paths.mcpIntents, body.requestId), body);
}

export function pollMcpIntents(client: NodeClient, paths: NodePaths, inflight: Set<string>, send: (frame: string) => boolean): void {
  if (!client.authenticated) return;
  ensureDir(paths.mcpIntents);
  for (const name of fs.readdirSync(paths.mcpIntents).filter((entry) => entry.endsWith(".json")).slice(0, 128)) {
    const file = path.join(paths.mcpIntents, name);
    let body: unknown;
    try { body = readJson(file); } catch { continue; }
    if (!isMcpIntentRegistration(body) || inflight.has(body.requestId)) continue;
    const [frame] = client.registerMcpIntent(body);
    if (frame && send(frame)) inflight.add(body.requestId);
  }
}

export function recordMcpIntentReceipt(paths: NodePaths, inflight: Set<string>, body: McpIntentReceiptBody): void {
  if (!isMcpIntentReceiptBody(body)) return;
  ensureDir(paths.mcpReceipts);
  for (const name of fs.readdirSync(paths.mcpReceipts).filter((entry) => entry.endsWith(".json"))) {
    const file = path.join(paths.mcpReceipts, name);
    if (Date.now() - fs.statSync(file).mtimeMs > LOCAL_RECORD_RETENTION_MS) fs.unlinkSync(file);
  }
  writeJsonAtomic(fileOf(paths.mcpReceipts, body.requestId), body);
  inflight.delete(body.requestId);
  try { fs.unlinkSync(fileOf(paths.mcpIntents, body.requestId)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function readMcpIntentReceipt(paths: NodePaths, requestId: string): McpIntentReceiptBody | null {
  try {
    const body = readJson(fileOf(paths.mcpReceipts, requestId));
    return isMcpIntentReceiptBody(body) ? body : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function consumeMcpIntentReceipt(paths: NodePaths, requestId: string): McpIntentReceiptBody | null {
  const body = readMcpIntentReceipt(paths, requestId);
  if (body) fs.unlinkSync(fileOf(paths.mcpReceipts, requestId));
  return body;
}

export function readMcpInbox(paths: NodePaths, sessionId: string, limit: number): McpInboxItem[] {
  return listInbox(paths.inbox, sessionId).slice(-limit).map((record) => ({
    messageId: record.messageId, from: { ...record.from }, createdAt: record.createdAt, text: record.text,
    ...(record.inReplyTo ? { inReplyTo: record.inReplyTo } : {}), depth: record.depth ?? 0,
  }));
}

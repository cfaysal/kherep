import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";

import { findCodex } from "./codex-binary.mts";
import type { NodePaths } from "./config.mts";
import { cleanupOwnedQueues, NativeQueueShutdownError, type NativeQueueClient, type QueuePage } from "./codex-queue-cleanup.mts";
import { isDirectNativeQueueIdentity, queueProducerIdentity } from "./codex-queue-context.mts";
import type { QueueProducerIdentity } from "./codex-queue-binding.mts";

export const MAX_NATIVE_QUEUE_LINE_BYTES = 1024 * 1024;
export type NativeSpawn = (file: string, args: string[], options: SpawnOptions) => ChildProcessWithoutNullStreams;
interface NativeOptions {
  spawn?: NativeSpawn;
  requestTimeoutMs?: number;
  opened?: (client: NativeQueueClient) => void;
}
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

class StdioQueueClient implements NativeQueueClient {
  private child: ChildProcessWithoutNullStreams;
  private requestTimeoutMs: number;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private failed: Error | null = null;
  private closing?: Promise<void>;

  constructor(child: ChildProcessWithoutNullStreams, requestTimeoutMs: number) {
    this.child = child;
    this.requestTimeoutMs = requestTimeoutMs;
    child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    child.stderr.resume();
    child.stdin.on("error", (error) => this.fail(error));
    child.once("error", (error) => this.fail(error));
    child.once("exit", () => this.fail(new Error("Codex app server exited")));
  }

  private rejectPending(error: Error): void {
    const failure = this.failed ?? error;
    this.failed = failure;
    const pendingRequests = [...this.pending.values()];
    this.pending.clear();
    for (const pending of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
  }

  private fail(error: Error): void {
    this.rejectPending(error);
    if (this.child.exitCode === null && this.child.signalCode === null && !this.child.killed) this.child.kill();
  }

  private read(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_NATIVE_QUEUE_LINE_BYTES) {
      return this.fail(new Error("Codex app server response is too large"));
    }
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) return;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      let response: unknown;
      try { response = JSON.parse(line); } catch { continue; }
      if (!object(response) || typeof response.id !== "number") continue;
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.error !== undefined) pending.reject(new Error("Codex app server rejected queue request"));
      else pending.resolve(response.result);
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.failed) return Promise.reject(this.failed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Codex app server ${method} timed out`);
        reject(error);
        this.fail(error);
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); } catch (error) {
        this.fail(error as Error);
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.failed) this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async list(owner: string, cursor?: string): Promise<QueuePage> {
    const result = await this.request("thread/queue/list", { threadId: owner, ...(cursor ? { cursor } : {}), limit: 100 });
    if (!object(result) || !Array.isArray(result.data)
      || !(result.nextCursor === null || typeof result.nextCursor === "string")) throw new Error("invalid Codex queue list response");
    const rows = result.data.filter((row): row is { id: string; input: unknown } => object(row)
      && typeof row.id === "string" && Object.hasOwn(row, "input"));
    if (rows.length !== result.data.length) throw new Error("invalid Codex queue row");
    return { data: rows, nextCursor: result.nextCursor as string | null };
  }

  async delete(owner: string, queueId: string): Promise<{ deleted: boolean }> {
    const result = await this.request("thread/queue/delete", { threadId: owner, queuedSubmissionId: queueId });
    if (!object(result) || typeof result.deleted !== "boolean") throw new Error("invalid Codex queue delete response");
    return { deleted: result.deleted };
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.child.once("exit", () => { clearTimeout(timer); resolve(true); });
    });
  }

  close(): Promise<void> {
    return this.closing ??= this.closeOnce();
  }

  private async closeOnce(): Promise<void> {
    this.rejectPending(new Error("Codex app server closed"));
    this.child.stdin.end();
    if (await this.waitForExit(125)) return;
    this.child.kill("SIGKILL");
    if (!await this.waitForExit(125)) throw new NativeQueueShutdownError();
  }
}

export async function connectNativeQueue(identity: QueueProducerIdentity, options: NativeOptions = {}): Promise<NativeQueueClient> {
  const child = (options.spawn ?? spawn as NativeSpawn)(identity.launchFile,
    [...identity.launchPrefix, "app-server", "--listen", "stdio://"], {
      stdio: "pipe", windowsHide: true, env: { ...process.env, CODEX_HOME: identity.resolvedCodexHome },
    });
  const client = new StdioQueueClient(child, options.requestTimeoutMs ?? 2_000);
  try {
    options.opened?.(client);
    await client.request("initialize", { clientInfo: { name: "kherep_queue_cleanup", version: "0.2.0" },
      capabilities: { experimentalApi: true } });
    client.notify("initialized", {});
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

export async function cleanupNativeOwnedQueues(paths: NodePaths, owner: string): Promise<void> {
  const file = findCodex();
  if (!file) return;
  const started = Date.now();
  const deadlineAt = started + 5_000;
  const identity = queueProducerIdentity(file, ["app-server", "--listen", "stdio://"], {}, process.env, deadlineAt);
  if (!isDirectNativeQueueIdentity(identity)) return;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return;
  await cleanupOwnedQueues(paths, identity,
    (opened) => connectNativeQueue(identity, { requestTimeoutMs: Math.min(2_000, remaining), opened }),
    { owner, timeoutMs: remaining });
}

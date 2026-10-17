import { spawn } from "node:child_process";

import { AppServerClient, MAX_APP_SERVER_LINE_BYTES, type AppServerOptions, type AppServerSpawn } from "./codex-app-server-client.mts";
import type { NodePaths } from "./config.mts";
import {
  cleanupOwnedQueues, deliveredQueueBindings, sameIdentity, NativeQueueShutdownError,
  type NativeQueueClient, type QueuePage,
} from "./codex-queue-cleanup.mts";
import { isDirectNativeQueueIdentity, queueProducerIdentity } from "./codex-queue-context.mts";
import type { QueueProducerIdentity } from "./codex-queue-binding.mts";

// Issue #408: the JSON-RPC client lives in codex-app-server-client.mts; this
// file keeps the Queue list and delete on top of it, unchanged in behaviour.
export const MAX_NATIVE_QUEUE_LINE_BYTES = MAX_APP_SERVER_LINE_BYTES;
export type NativeSpawn = AppServerSpawn;
interface NativeOptions {
  spawn?: NativeSpawn;
  requestTimeoutMs?: number;
  opened?: (client: NativeQueueClient) => void;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

class StdioQueueClient extends AppServerClient implements NativeQueueClient {
  private whenStopped: Promise<void>;

  constructor(child: ReturnType<NativeSpawn>, options: AppServerOptions) {
    super(child, options);
    this.whenStopped = new Promise(resolve => {
      let exited = false, closed = false;
      const check = (): void => { if (exited && closed) resolve(); };
      child.once("exit", () => { exited = true; check(); });
      child.once("close", () => { closed = true; check(); });
    });
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

  async close(): Promise<void> {
    let stopped: boolean;
    try { stopped = await this.shutdown(); }
    catch (cause) { throw new NativeQueueShutdownError(this.whenStopped, { cause }); }
    if (!stopped) throw new NativeQueueShutdownError(this.whenStopped);
  }
}

export async function connectNativeQueue(identity: QueueProducerIdentity, options: NativeOptions = {}): Promise<NativeQueueClient> {
  const child = (options.spawn ?? spawn as NativeSpawn)(identity.launchFile,
    [...identity.launchPrefix, "app-server", "--listen", "stdio://"], {
      stdio: "pipe", windowsHide: true, env: { ...process.env, CODEX_HOME: identity.resolvedCodexHome },
    });
  const client = new StdioQueueClient(child, { requestTimeoutMs: options.requestTimeoutMs ?? 2_000 });
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

export async function cleanupNativeOwnedQueues(paths: NodePaths, owner: string,
  options: { open?: typeof connectNativeQueue } = {}): Promise<void> {
  const deadlineAt = Date.now() + 5_000;
  const checked = new Set<string>();
  for (const binding of deliveredQueueBindings(paths, owner)) {
    if (Date.now() >= deadlineAt) return;
    const key = JSON.stringify(binding.producer);
    if (checked.has(key)) continue;
    checked.add(key);
    const identity = queueProducerIdentity(binding.producer.codexExecutable,
      ["app-server", "--listen", "stdio://"], {}, process.env, deadlineAt);
    if (!isDirectNativeQueueIdentity(identity) || !sameIdentity(binding.producer, identity)) continue;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return;
    await cleanupOwnedQueues(paths, identity,
      (opened) => (options.open ?? connectNativeQueue)(identity, { requestTimeoutMs: Math.min(2_000, remaining), opened }),
      { owner, timeoutMs: remaining });
  }
}

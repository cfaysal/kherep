import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { lastLine } from "./codex-output.mts";

// A JSON-RPC client over the stdio of one `codex app-server --listen stdio://`
// (issue #408, design section 4.2), extracted from the native Queue client:
// line framing with a bounded buffer, request ids and timeouts, close with a
// bounded wait. Every message without an id is a notification for the
// listeners; a message with an id and a method is a server request, answered
// at once with -32601 because no caller of this client has approval authority;
// the method decides, so a request whose id equals a pending one is never
// taken for its response.

export const MAX_APP_SERVER_LINE_BYTES = 1024 * 1024;
export type AppServerSpawn = (file: string, args: string[], options: SpawnOptions) => ChildProcessWithoutNullStreams;
export interface AppServerMessage { method: string; params?: unknown; id?: unknown }
// What the kill path reports about its target: "sent" (the signal reached a live
// target), "absent" (the OS states that no process of the target exists), or
// "unconfirmed" (not sent, or unknown). A kill that throws is "unconfirmed".
export type KillReport = "sent" | "absent" | "unconfirmed";
export const SERVER_REQUEST_REFUSAL = { code: -32601, message: "kherep fork reply has no approval authority" };

// A rejected request: the method only in the message. detail is a redacted
// last line of the server's message, for logs; rawMessage is the message byte
// for byte, only for exact comparisons (codex-fork-goal.mts) and never logged.
export class AppServerRequestError extends Error {
  readonly code: number | undefined;
  readonly detail: string;
  readonly rawMessage: string | undefined;
  constructor(method: string, error: unknown) {
    super(`Codex app server rejected ${method}`);
    const fields = typeof error === "object" && error !== null ? error as { code?: unknown; message?: unknown } : {};
    this.code = typeof fields.code === "number" ? fields.code : undefined;
    this.rawMessage = typeof fields.message === "string" ? fields.message : undefined;
    this.detail = this.rawMessage === undefined ? "" : lastLine(this.rawMessage);
  }
}

// A request without an answer within its timeout.
export class AppServerTimeoutError extends Error {
  constructor(method: string) { super(`Codex app server ${method} timed out`); }
}

// The process ended: a request pending then can no longer be answered.
export class AppServerExitedError extends Error {
  constructor() { super("Codex app server exited"); }
}

// graceMs: each of the two waits of close. kill: the signal path with its report
// (the child itself by default, reported sent). forceAfterFailure: after a
// failure, close always ends with SIGKILL, because the direct child's exit does
// not prove that its process group is empty (issue #432). strict: an
// unparsable line fails the client.
export interface AppServerOptions {
  requestTimeoutMs: number; graceMs?: number; kill?: (signal: NodeJS.Signals) => KillReport; forceAfterFailure?: boolean; strict?: boolean;
  onServerRequest?: (message: AppServerMessage) => void;
}
interface Pending { method: string; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export class AppServerClient {
  protected child: ChildProcessWithoutNullStreams;
  private options: AppServerOptions;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private buffer = "";
  // A multibyte character split across two chunks decodes whole (issue #408).
  private decoder = new StringDecoder("utf8");
  private failed: Error | null = null;
  private closing?: Promise<boolean>;
  private exited = false;
  private closed = false;
  private forced = false;
  // The report of the forced SIGKILL of the close, null before it was sent.
  killReport: KillReport | null = null;
  private notificationListeners: ((message: AppServerMessage) => void)[] = [];
  private failureListeners: ((error: Error) => void)[] = [];

  constructor(child: ChildProcessWithoutNullStreams, options: AppServerOptions) {
    this.child = child;
    this.options = options;
    child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    child.stderr.resume();
    child.stdin.on("error", (error) => this.fail(error));
    child.once("error", (error) => this.fail(error));
    child.once("exit", () => { this.exited = true; this.fail(new AppServerExitedError()); });
    child.once("close", () => { this.closed = true; });
  }

  onNotification(listener: (message: AppServerMessage) => void): void { this.notificationListeners.push(listener); }
  onFailure(listener: (error: Error) => void): void {
    if (this.failed) listener(this.failed);
    else this.failureListeners.push(listener);
  }
  get failure(): Error | null { return this.failed; }

  private rejectPending(error: Error): void {
    const first = this.failed === null;
    const failure = this.failed ?? error;
    this.failed = failure;
    const pendingRequests = [...this.pending.values()];
    this.pending.clear();
    for (const pending of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    if (first) for (const listener of this.failureListeners.splice(0)) listener(failure);
  }

  private fail(error: Error): void {
    this.rejectPending(error);
    if (this.child.exitCode === null && this.child.signalCode === null && !this.child.killed) this.kill("SIGTERM");
  }

  // Without a kill option the direct child is the target, and its own exit and
  // close (what waitForShutdown measures) confirm the kill, so it reports "sent".
  private kill(signal: NodeJS.Signals): KillReport {
    if (!this.options.kill) { this.child.kill(signal); return "sent"; }
    try { return this.options.kill(signal); } catch { return "unconfirmed"; }
  }

  private write(message: unknown): void {
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); } catch (error) { this.fail(error as Error); }
  }

  private read(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_APP_SERVER_LINE_BYTES) {
      return this.fail(new Error("Codex app server response is too large"));
    }
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) return;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      let message: unknown;
      try { message = JSON.parse(line); } catch {
        if (this.options.strict && line.trim()) return this.fail(new Error("Codex app server sent a malformed line"));
        continue;
      }
      if (!object(message)) continue;
      if (typeof message.method === "string") {
        const received = message as unknown as AppServerMessage;
        if (message.id === undefined) for (const listener of this.notificationListeners) listener(received);
        else {
          if (!this.failed) this.write({ id: message.id, error: SERVER_REQUEST_REFUSAL });
          this.options.onServerRequest?.(received);
        }
        continue;
      }
      if (typeof message.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) pending.reject(new AppServerRequestError(pending.method, message.error));
      else pending.resolve(message.result);
    }
  }

  request(method: string, params: unknown, timeoutMs: number = this.options.requestTimeoutMs): Promise<unknown> {
    if (this.failed) return Promise.reject(this.failed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new AppServerTimeoutError(method);
        reject(error);
        this.fail(error);
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.failed) this.write({ method, params });
  }

  private waitForShutdown(timeoutMs: number): Promise<boolean> {
    if (this.exited && this.closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      const check = (): void => {
        if (!this.exited || !this.closed) return;
        clearTimeout(timer);
        resolve(true);
      };
      this.child.once("exit", check);
      this.child.once("close", check);
    });
  }

  // The close, running or not yet started, ends with the group SIGKILL (issue #432; a late watch violation).
  escalate(): void { this.forced = true; }

  // True when both exit and close of the child were seen. force or a later
  // escalate(): end with SIGKILL whatever the child does, as after a failure
  // (a timed-out turn), also when the close is already running.
  shutdown(force = false): Promise<boolean> {
    if (force) this.escalate();
    return this.closing ??= this.shutdownOnce();
  }

  private async shutdownOnce(): Promise<boolean> {
    // Evaluated once when the close starts: fail() runs on every exit, so a clean close stays signal-free.
    if (this.options.forceAfterFailure === true && this.failed !== null) this.forced = true;
    this.rejectPending(new Error("Codex app server closed"));
    this.child.stdin.end();
    const grace = this.options.graceMs ?? 125;
    if (await this.waitForShutdown(grace) && !this.forced) return true;
    // Fail closed: a group kill the OS did not confirm leaves the group unknown, whatever the direct child did.
    this.killReport = this.kill("SIGKILL");
    return this.killReport !== "unconfirmed" && await this.waitForShutdown(grace);
  }
}

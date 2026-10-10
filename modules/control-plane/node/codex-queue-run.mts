import { spawn } from "node:child_process";

import { codexCommand, findCodex } from "./codex-binary.mts";
import { lastLine } from "./codex-output.mts";
import { signalGroup } from "./codex-process.mts";
import { queueProducerIdentity } from "./codex-queue-context.mts";
import type { NativeQueueInput, QueueProducerIdentity } from "./codex-queue-binding.mts";
import { isCodexSessionId } from "./codex-sessions.mts";
import type { RunnerDeps } from "./session-runner.mts";

export const QUEUE_TIMEOUT_MS = 30_000;
export const MAX_QUEUE_STDOUT_BYTES = 8 * 1024;
const FORBIDDEN = /^(--dangerously-|--approve-for-me$|--add-dir$|--sandbox$|-s$|-c$|--config$)/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export interface QueueRunResult {
  owner: string;
  expectedInput: NativeQueueInput[];
  producer: QueueProducerIdentity;
  queueId?: string;
}

export function parseQueueAdmission(stdout: string, owner: string, overflow = false): string | null {
  if (overflow || Buffer.byteLength(stdout, "utf8") > MAX_QUEUE_STDOUT_BYTES) return null;
  const pattern = new RegExp(`^Queued message (${UUID}) for thread (${UUID})\\.$`, "i");
  const matches = stdout.split(/\r?\n/).flatMap((line) => {
    const match = pattern.exec(line);
    return match ? [{ queueId: match[1]!, owner: match[2]! }] : [];
  });
  return matches.length === 1 && matches[0]!.owner.toLowerCase() === owner.toLowerCase() ? matches[0]!.queueId : null;
}

function queueInput(args: string[]): { owner: string; text: string } {
  if (args.length !== 5 || args[0] !== "queue" || args[1] !== "--thread" || args[3] !== "--message"
    || !new RegExp(`^${UUID}$`, "i").test(args[2]!)) throw new Error("invalid fixed Codex queue arguments");
  return { owner: args[2]!, text: args[4]! };
}

export function queueArgs(thread: string, count: number): string[] {
  if (!isCodexSessionId(thread)) throw new Error("codex session id is not a plain name");
  return guardQueue(["queue", "--thread", thread, "--message", `Kherep: ${count} peer message(s) waiting in your inbox.`]);
}

export function guardQueue(args: string[]): string[] {
  if (args.some((arg) => FORBIDDEN.test(arg))) throw new Error("refusing a codex queue flag that changes the sandbox or approvals");
  return args;
}

// Runs codex without a shell, in its own process group on POSIX. The launcher
// may leave stderr open, so exit has a short bounded drain grace period.
export function runQueue(deps: RunnerDeps, args: string[]): Promise<QueueRunResult> {
  const file = (deps.codex?.findCodex ?? findCodex)();
  if (!file) return Promise.reject(new Error("codex is not installed on this node"));
  const { owner, text } = queueInput(args);
  const platform = deps.codex?.platform ?? process.platform;
  const command = codexCommand(file, args, platform);
  const producer = queueProducerIdentity(file, args, deps);
  const timeoutMs = deps.codex?.queueTimeoutMs ?? QUEUE_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args,
      { stdio: ["ignore", "pipe", "pipe"], detached: platform !== "win32", windowsHide: true });
    let stdout = "";
    let stdoutBytes = 0;
    let stdoutOverflow = false;
    let stderr = "";
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (error) reject(error);
      else {
        const queueId = parseQueueAdmission(stdout, owner, stdoutOverflow);
        resolve({ owner, expectedInput: [{ type: "text", text, text_elements: [] }], producer, ...(queueId ? { queueId } : {}) });
      }
    };
    const timer = setTimeout(() => {
      if (child.pid !== undefined) (deps.codex?.signal ?? ((pid, signal) => signalGroup(pid, signal, platform)))(child.pid, "SIGKILL");
      settle(new Error(`codex queue did not finish within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_QUEUE_STDOUT_BYTES) stdoutOverflow = true;
      else stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4096); });
    child.once("error", (error) => settle(error));
    child.once("exit", (code, signal) => {
      const done = (): void => settle(code === 0 ? undefined : new Error(lastLine(stderr) || `codex queue ended with ${String(code ?? signal)}`));
      const grace = setTimeout(done, 250);
      child.once("close", () => { clearTimeout(grace); done(); });
    });
  });
}

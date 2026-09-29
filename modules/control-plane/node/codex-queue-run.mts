import { spawn } from "node:child_process";

import { codexCommand, findCodex } from "./codex-binary.mts";
import { lastLine } from "./codex-output.mts";
import { signalGroup } from "./codex-process.mts";
import { isCodexSessionId } from "./codex-sessions.mts";
import type { RunnerDeps } from "./session-runner.mts";
import { wakeText } from "./wake-hook.mts";

export const QUEUE_TIMEOUT_MS = 30_000;
const FORBIDDEN = /^(--dangerously-|--approve-for-me$|--add-dir$|--sandbox$|-s$|-c$|--config$)/;

export function queueArgs(thread: string, count: number): string[] {
  if (!isCodexSessionId(thread)) throw new Error("codex session id is not a plain name");
  return guardQueue(["queue", "--thread", thread, "--message", wakeText(count)]);
}

export function guardQueue(args: string[]): string[] {
  if (args.some((arg) => FORBIDDEN.test(arg))) throw new Error("refusing a codex queue flag that changes the sandbox or approvals");
  return args;
}

// Runs codex without a shell, in its own process group on POSIX. The launcher
// may leave stderr open, so exit has a short bounded drain grace period.
export function runQueue(deps: RunnerDeps, args: string[]): Promise<void> {
  const file = (deps.codex?.findCodex ?? findCodex)();
  if (!file) return Promise.reject(new Error("codex is not installed on this node"));
  const platform = deps.codex?.platform ?? process.platform;
  const command = codexCommand(file, args, platform);
  const timeoutMs = deps.codex?.queueTimeoutMs ?? QUEUE_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, { stdio: ["ignore", "ignore", "pipe"], detached: platform !== "win32", windowsHide: true });
    let stderr = "";
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stderr?.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      if (child.pid !== undefined) (deps.codex?.signal ?? ((pid, signal) => signalGroup(pid, signal, platform)))(child.pid, "SIGKILL");
      settle(new Error(`codex queue did not finish within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4096); });
    child.once("error", (error) => settle(error));
    child.once("exit", (code, signal) => {
      const done = (): void => settle(code === 0 ? undefined : new Error(lastLine(stderr) || `codex queue ended with ${String(code ?? signal)}`));
      const grace = setTimeout(done, 250);
      child.once("close", () => { clearTimeout(grace); done(); });
    });
  });
}
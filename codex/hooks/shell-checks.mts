import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { HookPayload } from "./hook-adapter.mts";

const GUARDS = [["commit-guard.mts", "pre"], ["deploy-guard.mts", "pre-no-transcript"],
  ["main-checkout-guard.mts", "pre"]] as const;
const deny = (reason: string): string => JSON.stringify({ hookSpecificOutput: {
  hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason,
} });

// Privacy stays in its independent group. All shell guards still run through
// the shared adapter's phase-specific normalization, even when another denies.
export async function shellChecks(payload: HookPayload, attributionHook?: string): Promise<string> {
  let runAdaptedHook: typeof import("./hook-adapter.mts").runAdaptedHook;
  try { ({ runAdaptedHook } = await import("./hook-adapter.mts")); }
  catch { return deny("Shell guard adapter could not load; this tool call is blocked."); }
  let decision = "";
  for (const [guard, phase] of GUARDS) {
    try {
      const target = path.join(import.meta.dirname, guard);
      if (!fs.statSync(target).size) throw new Error("empty guard");
      const result = runAdaptedHook(target, phase, payload, 10_000);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.status !== 0) decision ||= deny(`${guard} failed; this tool call is blocked.`);
      else if (result.stdout.trim()) {
        // These three guards allow silently; their only supported stdout is
        // the adapter's native deny. Unexpected output must not allow a call.
        const output = JSON.parse(result.stdout) as { hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string } };
        if (output.hookSpecificOutput?.hookEventName !== "PreToolUse"
          || output.hookSpecificOutput.permissionDecision !== "deny") throw new Error("unsupported guard output");
        decision ||= result.stdout;
      }
    } catch { decision ||= deny(`${guard} could not complete; this tool call is blocked.`); }
  }
  if (attributionHook) {
    try {
      if (!path.isAbsolute(attributionHook)) throw new Error("invalid attribution path");
      const { handleAttributionHook } = await import(pathToFileURL(attributionHook).href);
      const { nodePaths } = await import(pathToFileURL(path.join(path.dirname(attributionHook), "config.mts")).href);
      handleAttributionHook(payload, "codex", { paths: nodePaths(), env: process.env });
    } catch { process.stderr.write("kherep shell-checks: attribution could not complete\n"); }
  }
  return decision;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  let output: string;
  try {
    const payload: unknown = JSON.parse(fs.readFileSync(0, "utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid input");
    output = await shellChecks(payload as HookPayload, process.argv[2]);
  } catch { output = deny("Shell checks received invalid input; this tool call is blocked."); }
  if (output) process.stdout.write(output);
}

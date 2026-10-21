#!/usr/bin/env node
// Issue #504. PostToolUse on SubagentHandback, wired through kherep/hook-runtime/entry.mts reader:
// after a delegated worker's handback executed, append a `delivered` line to its denied-call
// journal (<home>/.cache/denied-calls/<agent_id>.jsonl), else leave the capture-failed marker. It
// reads nothing of tool_input.message or tool_response, prints nothing and exits 0: a PostToolUse
// hook has no permission decision, so it cannot block the handback, which already ran.
import path from "node:path";
import process from "node:process";

import { agentKey, appendLine, deliveredLine, markCaptureFailed } from "./lib/denial-journal.mts";

const CAP_MS = 1_500, GRACE_MS = 400;
const START = Date.now();
// <home> is the parent of the hooks directory this file was started from.
const HOME = path.dirname(path.dirname(path.resolve(process.argv[1] ?? "")));

function readStdin(until: number): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    const timer = setTimeout(() => { process.stdin.destroy(); resolve(""); }, Math.max(0, until - Date.now()));
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => { clearTimeout(timer); resolve(data); });
    process.stdin.on("error", () => { clearTimeout(timer); resolve(""); });
  });
}

async function main(): Promise<void> {
  let payload: unknown;
  try { payload = JSON.parse(await readStdin(START + CAP_MS)); } catch { return; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const record = payload as Record<string, unknown>;
  const id = agentKey(record);
  if (!id || record.tool_name !== "SubagentHandback") return;
  const fail = await appendLine(HOME, id, deliveredLine(record), START + CAP_MS);
  if (fail) await markCaptureFailed(HOME, id, fail, Date.now() + GRACE_MS);
}

main().catch(() => {}).finally(() => process.exit(0));

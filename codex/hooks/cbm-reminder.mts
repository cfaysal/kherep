import fs from "node:fs";

export const MESSAGE = [
  "Code discovery protocol:",
  "1. Prefer codebase-memory-mcp graph tools for structural code exploration.",
  "2. Use search_graph before trace_path or get_code_snippet.",
  "3. Use text search for literals, configs, scripts, and non-code files.",
].join("\n");

export function main(): void {
  let input: { hook_event_name?: unknown } = {};
  try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return; }
  const event = input.hook_event_name;
  if (typeof event !== "string" || !["SessionStart", "SubagentStart"].includes(event)) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: MESSAGE },
  }));
}

if (import.meta.main) main();

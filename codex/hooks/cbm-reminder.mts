import fs from "node:fs";
import { pathToFileURL } from "node:url";

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

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) only matches after realpath.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
function isMainModule(): boolean {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] || "")).href;
  } catch {
    return false;
  }
}

if (isMainModule()) main();

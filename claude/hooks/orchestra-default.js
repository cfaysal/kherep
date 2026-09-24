#!/usr/bin/env node
/**
 * orchestra-default.js  -  SessionStart hook
 *
 * Defaults every session that operates in the configured Kherep workspace into
 * Kherep Maestro
 * mode and injects the compact, load-bearing contract once. Detailed policy
 * stays in ROUTING.md so every prompt is not flooded with duplicated rules.
 *
 * Fail-safe: any error exits 0 silently, never blocks session start.
 */
const fs = require("fs");
const path = require("path");
const { isKherepScope } = require("./lib/workspace-scope.mts");

function main() {
  let input = "";
  try {
    input = fs.readFileSync(0, "utf8");
  } catch {
    return;
  }
  let data = {};
  try {
    data = JSON.parse(input || "{}");
  } catch {
    return;
  }

  // Other projects keep stock Claude Code behavior. Transcript directory
  // slugs are intentionally not used: they differ between Windows and macOS.
  if (!isKherepScope(data)) return;

  const routingPath = path.join(
    process.env.USERPROFILE || process.env.HOME || "",
    ".claude",
    "teams",
    "kherep",
    "ROUTING.md"
  );

  const msg =
    `KHEREP ORCHESTRA ACTIVE. Read ${routingPath} before substantive work.\n` +
    `First substantial reply banner: [Maestro on | routing loaded | evidence-first].\n` +
    `Ground current state before answering; live evidence outranks memory. Delegate only for material benefit. ` +
    `Every Agent/Task call sets an explicit model permitted by the operator-configured routing policy. ` +
    `Privacy routes only through the direct local-inference runner; win-agent/mac-agent remain Claude wrappers and are non-private only. ` +
    `Behavior-changing builds use Agent by default and require objective verification plus an Evidence/Accept receipt. ` +
    `Trivial conversational turns skip orchestration ceremony.`;

  const out = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: msg,
    },
  };
  process.stdout.write(JSON.stringify(out));
}

try {
  main();
} catch {
  // never break session start
}
process.exit(0);

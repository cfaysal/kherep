// Explicit diagnostic fixture for issue #374. Never installed by the product.
// Native stdin is inspected only as metadata; no transcript or Inbox is read.
import fs from "node:fs";
import { postToolOriginalOwner, rolloutThreadId } from "../../../modules/control-plane/node/codex-hook-owner.mts";

function argument(name: string): string {
  const at = process.argv.indexOf(name);
  if (at < 0 || !process.argv[at + 1]) throw new Error("missing diagnostic argument");
  return process.argv[at + 1];
}

try {
  const owner = argument("--owner");
  const output = argument("--out");
  const markerFile = argument("--marker-file");
  const input: unknown = JSON.parse(fs.readFileSync(0, "utf8"));
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const payload = input as Record<string, unknown>;
    if (payload.session_id === owner) {
      const evidence = {
        eventMatches: payload.hook_event_name === "PostToolUse",
        sessionMatches: true,
        threadMatches: rolloutThreadId(payload.transcript_path) === owner,
        childFieldsPresent: "agent_id" in payload || "agent_type" in payload,
        ownerGateAllows: postToolOriginalOwner(payload, owner),
      };
      fs.appendFileSync(output, JSON.stringify(evidence) + "\n");
      if (evidence.ownerGateAllows) {
        if (fs.statSync(markerFile).size > 128) throw new Error("invalid synthetic marker");
        const marker = fs.readFileSync(markerFile, "utf8").trim();
        if (!/^PROBE374-[A-Z0-9]+$/.test(marker)) throw new Error("invalid synthetic marker");
        process.stdout.write(JSON.stringify({ hookSpecificOutput: {
          hookEventName: "PostToolUse", additionalContext: "Synthetic metadata control marker: " + marker,
        } }));
      }
    }
  }
} catch {
  // Never reveal a native payload, filename or exception to model-visible logs.
  process.stderr.write("busy-owner-probe could not complete the diagnostic\n");
  process.exitCode = 1;
}

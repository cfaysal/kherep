import fs from "node:fs";
import path from "node:path";

export interface PreCompactInput {
  transcript_path?: unknown;
  session_id?: unknown;
  cwd?: unknown;
}

export function safeId(value: unknown): string {
  return String(value || "unknown").replace(/[^a-z0-9_-]/gi, "_").slice(0, 120);
}

export function writeFallback(input: PreCompactInput): string | null {
  const transcript = input.transcript_path;
  if (typeof transcript !== "string" || !transcript || !path.isAbsolute(transcript)) return null;
  const normalized = path.resolve(transcript).replace(/\\/g, "/").toLowerCase();
  if (/(?:^|\/)\.claude(?:-mem)?(?:\/|$)/.test(normalized)) return null;
  const directory = path.join(path.dirname(transcript), "memory", "codex-checkpoints");
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `${safeId(input.session_id)}.json`);
  fs.writeFileSync(target, JSON.stringify({
    cwd: input.cwd || null,
    session_id: input.session_id || null,
    timestamp: new Date().toISOString(),
    transcript_path: transcript,
  }, null, 2) + "\n", "utf8");
  return target;
}

function main(): void {
  let input: PreCompactInput = {};
  try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return; }
  const target = writeFallback(input);
  if (target) process.stdout.write(JSON.stringify({ systemMessage: "Local Codex pre-compact metadata recorded; the task transcript remains the continuity source." }));
}

if (import.meta.main) main();

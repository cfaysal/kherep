// Version-bound metadata contract, issue #374. Core supplies the current
// live thread's transcript_path; its canonical basename carries thread_id
// before an optional reverted rollout_id. No transcript is opened.
// Verified in openai/codex d27764b82f7118f674371e6d6e76271d9d606edb
// and 740e5af33c71225640e0c1c1555c514c2c93ab74, rollout_file_name.rs.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const OWNER_ID = new RegExp(`^${UUID}$`);
const ROLLOUT_NAME = new RegExp(`^rollout-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2})-(${UUID})(?:_${UUID})?\\.jsonl$`);

export function rolloutThreadId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 8192 || value.includes("\u0000")) return;
  const match = ROLLOUT_NAME.exec(value.split(/[\\/]/).at(-1) || "");
  if (!match) return;
  const iso = match[1].slice(0, 10) + "T" + match[1].slice(11).replaceAll("-", ":");
  const millis = Date.parse(iso + "Z");
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 19) !== iso) return;
  return match[2];
}

export function postToolOriginalOwner(input: unknown, owner: string): boolean {
  if (!OWNER_ID.test(owner) || !input || typeof input !== "object" || Array.isArray(input)) return false;
  const payload = input as Record<string, unknown>;
  // Review and other non-ThreadSpawn children may share session_id without
  // these fields. Field rejection alone is deliberately insufficient.
  return payload.hook_event_name === "PostToolUse" && payload.session_id === owner
    && !("agent_id" in payload) && !("agent_type" in payload)
    && rolloutThreadId(payload.transcript_path) === owner;
}

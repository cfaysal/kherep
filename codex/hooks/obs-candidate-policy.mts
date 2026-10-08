// Issue #326. codex-obs returns one strict JSON candidate and nothing else
// (codex/agents/codex-obs.md, Codex candidate-only mode). The SubagentStop hook
// obs-result-check.mts applies this check before the Maestro publishes.
//
// - The whole message parses as JSON: a Markdown fence or prose around the
//   document is malformed (operator decision 2026-10-08, strict).
// - Its only key is `observations`, an array. An empty array is valid.
// - Each candidate has exactly title, bodyStorage, evidence, labels and
//   placement; evidence is one of the four values; labels are exactly
//   type-observation, evidence-<value> and status-author-model in any order;
//   placement is exactly a non-empty project and app.
//
// Pure: no I/O, and a problem is a fixed text that never quotes the message.

export type CandidateCheck = { count: number } | { problem: string };

const EVIDENCE = new Set(["confirmed", "assumed", "refuted", "superseded"]);
// Sorted: hasExactKeys compares them with the sorted own keys.
const CANDIDATE_KEYS = ["bodyStorage", "evidence", "labels", "placement", "title"];
const PLACEMENT_KEYS = ["app", "project"];
const ENVELOPE_KEYS = ["observations"];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, index) => key === keys[index]);
}

function filled(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function candidateProblem(value: unknown): string | null {
  const item = record(value);
  if (!item) return "a candidate is no object";
  if (!hasExactKeys(item, CANDIDATE_KEYS)) return "a candidate does not have exactly title, bodyStorage, evidence, labels and placement";
  if (!filled(item.title) || !filled(item.bodyStorage)) return "a candidate has an empty title or bodyStorage";
  if (typeof item.evidence !== "string" || !EVIDENCE.has(item.evidence)) return "a candidate has an unknown evidence value";
  const expected = new Set(["type-observation", `evidence-${item.evidence}`, "status-author-model"]);
  const labels = item.labels;
  if (!Array.isArray(labels) || labels.length !== 3 || new Set(labels).size !== 3 || !labels.every((label) => expected.has(label))) {
    return "a candidate's labels are not exactly the three base labels";
  }
  const placement = record(item.placement);
  if (!placement || !hasExactKeys(placement, PLACEMENT_KEYS) || !filled(placement.project) || !filled(placement.app)) {
    return "a candidate's placement is not exactly a non-empty project and app";
  }
  return null;
}

export function checkObsCandidate(message: string): CandidateCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return { problem: "the message is no strict JSON document" };
  }
  const envelope = record(parsed);
  if (!envelope || !hasExactKeys(envelope, ENVELOPE_KEYS) || !Array.isArray(envelope.observations)) {
    return { problem: "the document's only key is not an observations array" };
  }
  for (const item of envelope.observations) {
    const problem = candidateProblem(item);
    if (problem) return { problem };
  }
  return { count: envelope.observations.length };
}

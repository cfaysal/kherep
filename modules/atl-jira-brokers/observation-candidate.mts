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
// - Issue #505: on a confirmed candidate, every `<p>Revision: …</p>` paragraph
//   its body carries is exactly <repo>@<full commit sha>. Assumed bodies and a body
//   without such a line are not checked: absence is undeclared.
//
// Pure: no I/O, and a problem is a fixed text that never quotes the message.
export type CandidateCheck = {
    count: number;
} | {
    problem: string;
};
const EVIDENCE = new Set(["confirmed", "assumed", "refuted", "superseded"]);
// Sorted: hasExactKeys compares them with the sorted own keys.
const CANDIDATE_KEYS = ["bodyStorage", "evidence", "labels", "placement", "title"];
const PLACEMENT_KEYS = ["app", "project"];
const ENVELOPE_KEYS = ["observations"];
const REVISION_LINE = /<p>\s*Revision:((?:(?!<\/p>)[\s\S])*)<\/p>/g;
// The name grammar of claude/hooks/lib/obs-brief-policy.mts NAME, then @<40 hex>.
const BOUND_REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*@[0-9a-f]{40}$/;
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
    if (!item)
        return "a candidate is no object";
    if (!hasExactKeys(item, CANDIDATE_KEYS))
        return "a candidate does not have exactly title, bodyStorage, evidence, labels and placement";
    if (!filled(item.title) || !filled(item.bodyStorage))
        return "a candidate has an empty title or bodyStorage";
    if (typeof item.evidence !== "string" || !EVIDENCE.has(item.evidence))
        return "a candidate has an unknown evidence value";
    const expected = new Set(["type-observation", `evidence-${item.evidence}`, "status-author-model"]);
    const labels = item.labels;
    if (!Array.isArray(labels)) return "a candidate's labels are not exactly the three base labels";
    const allowed = labels.every(label => typeof label === 'string'
        && (expected.has(label) || /^product-(jira|confluence|jsm)$/.test(label)));
    const basePresent = [...expected].every(label => labels.includes(label));
    const bounded = labels.length >= 3 && labels.length <= 4;
    const distinct = new Set(labels).size === labels.length;
    if (!allowed || !basePresent || !bounded || !distinct) {
        return "a candidate's labels are not exactly the three base labels";
    }
    const placement = record(item.placement);
    if (!placement || !hasExactKeys(placement, PLACEMENT_KEYS) || !filled(placement.project) || !filled(placement.app)) {
        return "a candidate's placement is not exactly a non-empty project and app";
    }
    if (item.evidence === "confirmed"
        && [...(item.bodyStorage as string).matchAll(REVISION_LINE)].some(([, value]) => !BOUND_REVISION.test(value.trim()))) {
        return "a confirmed candidate names a revision that is not <repo>@<full commit sha>";
    }
    return null;
}
export function checkObsCandidate(message: string): CandidateCheck {
    let parsed: unknown;
    try {
        parsed = JSON.parse(message);
    }
    catch {
        return { problem: "the message is no strict JSON document" };
    }
    const envelope = record(parsed);
    if (!envelope || !hasExactKeys(envelope, ENVELOPE_KEYS) || !Array.isArray(envelope.observations)) {
        return { problem: "the document's only key is not an observations array" };
    }
    for (const item of envelope.observations) {
        const problem = candidateProblem(item);
        if (problem)
            return { problem };
    }
    return { count: envelope.observations.length };
}

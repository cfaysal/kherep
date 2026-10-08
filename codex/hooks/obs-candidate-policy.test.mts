import assert from "node:assert/strict";
import test from "node:test";

import { checkObsCandidate } from "./obs-candidate-policy.mts";

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Synthetic finding",
    bodyStorage: "<p>Synthetic body.</p>",
    evidence: "assumed",
    labels: ["type-observation", "evidence-assumed", "status-author-model"],
    placement: { project: "Synthetic project", app: "Synthetic app" },
    ...overrides,
  };
}

const doc = (...observations: unknown[]): string => JSON.stringify({ observations });
const problem = (message: string): string => {
  const check = checkObsCandidate(message);
  assert.ok("problem" in check, `expected a problem for ${message}`);
  return check.problem;
};

test("an empty observations array is valid", () => {
  assert.deepEqual(checkObsCandidate('{ "observations": [] }'), { count: 0 });
  assert.deepEqual(checkObsCandidate(`\n${doc()}\n`), { count: 0 });
});

test("well-formed candidates are valid for every evidence value and label order", () => {
  const items = ["confirmed", "assumed", "refuted", "superseded"].map((evidence) =>
    candidate({ evidence, labels: ["status-author-model", `evidence-${evidence}`, "type-observation"] }));
  assert.deepEqual(checkObsCandidate(doc(...items)), { count: 4 });
});

test("anything but one strict JSON document is malformed", () => {
  for (const message of [
    `\`\`\`json\n${doc()}\n\`\`\``,
    `Here is the candidate:\n${doc()}`,
    `${doc()}\nDone.`,
    "OBS-RESULT: empty nothing new",
    "",
  ]) assert.match(problem(message), /no strict JSON document/, message);
});

test("the envelope has exactly one observations array", () => {
  for (const message of ["[]", "null", '"observations"', '{"observations":{}}', "{}",
    JSON.stringify({ observations: [], note: "extra" })]) {
    assert.match(problem(message), /only key is not an observations array/, message);
  }
});

test("each candidate has exactly the five fields", () => {
  assert.match(problem(doc("text")), /no object/);
  assert.match(problem(doc(candidate({ related: "x" }))), /exactly title, bodyStorage/);
  const { placement: _placement, ...missing } = candidate();
  assert.match(problem(doc(missing)), /exactly title, bodyStorage/);
  assert.match(problem(doc(candidate({ title: " " }))), /empty title or bodyStorage/);
  assert.match(problem(doc(candidate({ bodyStorage: 7 }))), /empty title or bodyStorage/);
});

test("evidence and labels follow the four values and the three base labels", () => {
  assert.match(problem(doc(candidate({ evidence: "verified" }))), /unknown evidence value/);
  for (const labels of [
    ["type-observation", "evidence-confirmed", "status-author-model"],
    ["type-observation", "evidence-assumed"],
    ["type-observation", "evidence-assumed", "status-author-model", "session-1"],
    ["type-observation", "evidence-assumed", "evidence-assumed"],
    "type-observation",
  ]) assert.match(problem(doc(candidate({ labels }))), /three base labels/, JSON.stringify(labels));
});

test("placement is exactly a non-empty project and app", () => {
  for (const placement of [{ project: "p" }, { project: "p", app: "" }, { project: "p", app: "a", node: "n" }, "p/a", null]) {
    assert.match(problem(doc(candidate({ placement }))), /placement/, JSON.stringify(placement));
  }
});

test("a problem never quotes the message", () => {
  const secret = "Example Corp host.example.com";
  for (const message of [secret, doc(candidate({ evidence: secret })), doc(candidate({ placement: { project: secret } }))]) {
    assert.ok(!problem(message).includes("Example Corp"));
  }
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ISSUE_FIELDS,
  componentCatalogPath,
  fieldEdits,
  fieldListOr,
  parseAssignee,
  parseFieldList,
  readbackColumns,
  resolveComponentNames,
  verifyReadback,
} from "./jira-fields.mts";

// verifyReadback und parseAssignee melden ihren Befund als Text oder gar nicht.
// assert.match nimmt nur einen String, also wird der fehlende Befund hier
// benannt statt weggecastet: ein ausbleibender Fehler faellt so als solcher auf.
const reported = (value: string | null | undefined): string => value ?? "<kein Befund>";

const CATALOG = [
  { id: "10100", name: "Broker" },
  { id: 10101, name: "Hooks" },
];

test("an absent flag is null and an empty flag is an empty list", () => {
  assert.equal(parseFieldList(undefined), null);
  assert.equal(parseFieldList(null), null);
  assert.deepEqual(parseFieldList(""), []);
  assert.deepEqual(parseFieldList("   "), []);
  assert.deepEqual(parseFieldList("a, b ,,c"), ["a", "b", "c"]);
});

test("the catalog path is built from the project id", () => {
  assert.equal(componentCatalogPath("10111"), "/project/10111/components");
});

test("known names resolve to their component ids, numeric ids become strings", () => {
  assert.deepEqual(resolveComponentNames(["Hooks", "Broker"], CATALOG), { ids: ["10101", "10100"] });
});

test("a repeated name resolves to one id, so the readback comparison stays honest", () => {
  assert.deepEqual(resolveComponentNames(["Broker", "Broker"], CATALOG), { ids: ["10100"] });
});

test("an unknown name is refused and the message names it plus the known ones", () => {
  const refused = resolveComponentNames(["Broker", "Nirgends"], CATALOG);
  assert.equal(refused.ids, undefined);
  assert.match(reported(refused.error), /Nirgends/);
  assert.match(reported(refused.error), /Broker, Hooks/);
});

test("an unreadable catalog is refused instead of treated as an empty project", () => {
  assert.match(reported(resolveComponentNames(["Broker"], null).error), /Broker/);
  assert.match(reported(resolveComponentNames(["Broker"], null).error), /keine/);
});

test("a plan without either flag contributes no field and no readback column beyond the summary", () => {
  const plan = { labels: null, componentIds: null };
  assert.deepEqual(fieldEdits(plan), {});
  assert.equal(readbackColumns(plan), "summary");
  assert.equal(verifyReadback(plan, {}), null);
});

test("an empty list is a clearing edit, not an absent one", () => {
  assert.deepEqual(fieldEdits({ labels: [], componentIds: [] }), { labels: [], components: [] });
  assert.equal(readbackColumns({ labels: [], componentIds: [] }), "summary,labels,components");
  assert.equal(verifyReadback({ labels: [], componentIds: [] }, { labels: [], components: [] }), null);
});

test("components are sent in the documented id object shape", () => {
  assert.deepEqual(
    fieldEdits({ labels: ["x"], componentIds: ["10100", "10101"] }),
    { labels: ["x"], components: [{ id: "10100" }, { id: "10101" }] },
  );
});

test("the readback compares sets, so Jira may reorder without failing the run", () => {
  const plan = { labels: ["b", "a"], componentIds: ["10101", "10100"] };
  assert.equal(verifyReadback(plan, {
    labels: ["a", "b"],
    components: [{ id: "10100", name: "Broker" }, { id: 10101, name: "Hooks" }],
  }), null);
});

test("a label the readback does not show is reported with both sides", () => {
  const message = verifyReadback({ labels: ["a", "b"], componentIds: null }, { labels: ["a"] });
  assert.match(reported(message), /erwartet \[a, b\]/);
  assert.match(reported(message), /gelesen \[a\]/);
});

test("a component the readback does not show is reported with both sides", () => {
  const message = verifyReadback({ labels: null, componentIds: ["10100"] }, { components: [] });
  assert.match(reported(message), /Komponenten/);
  assert.match(reported(message), /erwartet \[10100\]/);
});

test("a missing field in the readback is a failure, not a silent pass", () => {
  assert.match(reported(verifyReadback({ labels: ["a"], componentIds: null }, {})), /keine Labels/);
  assert.match(reported(verifyReadback({ labels: null, componentIds: ["1"] }, {})), /keine Komponenten/);
  assert.match(reported(verifyReadback({ labels: ["a"], componentIds: null }, undefined)), /keine Labels/);
});

// ---- OP-1049: assignee ----

test("an absent assignee flag is null, an empty flag unassigns", () => {
  assert.equal(parseAssignee(undefined), null);
  assert.equal(parseAssignee(null), null);
  assert.deepEqual(parseAssignee(""), { accountId: null });
  assert.deepEqual(parseAssignee("   "), { accountId: null });
  assert.deepEqual(parseAssignee(" 712020:abc "), { accountId: "712020:abc" });
});

test("an accountId longer than the documented 128 characters is refused before the write", () => {
  const result = parseAssignee("x".repeat(129));
  assert.match(reported(result?.error), /129 Zeichen/);
  assert.equal(parseAssignee("x".repeat(128))?.accountId?.length, 128);
});

test("assignee is written as an accountId object, and clearing writes an explicit null", () => {
  assert.deepEqual(fieldEdits({ labels: null, componentIds: null, assignee: { accountId: "a1" } }),
    { assignee: { accountId: "a1" } });
  assert.deepEqual(fieldEdits({ labels: null, componentIds: null, assignee: { accountId: null } }),
    { assignee: { accountId: null } });
  assert.deepEqual(fieldEdits({ labels: null, componentIds: null, assignee: null }), {});
});

test("the readback asks for the assignee column only when one is planned", () => {
  assert.equal(readbackColumns({ labels: null, componentIds: null, assignee: { accountId: "a1" } }),
    "summary,assignee");
  assert.equal(readbackColumns({ labels: null, componentIds: null, assignee: null }), "summary");
});

test("a confirmed assignee passes and a different one fails", () => {
  const plan = { labels: null, componentIds: null, assignee: { accountId: "a1" } };
  assert.equal(verifyReadback(plan, { assignee: { accountId: "a1" } }), null);
  // Mutationsprobe: derselbe Aufbau mit einem anderen Konto MUSS fallen, sonst
  // beweist der gruene Fall oben nichts (Gotcha "gruene Tests ohne Mutationsprobe").
  const message = verifyReadback(plan, { assignee: { accountId: "a2" } });
  assert.match(reported(message), /erwartet a1/);
  assert.match(reported(message), /gelesen a2/);
});

test("unassigned reads back as null and is not confused with an unreadable field", () => {
  const clearing = { labels: null, componentIds: null, assignee: { accountId: null } };
  assert.equal(verifyReadback(clearing, { assignee: null }), null);
  // Fehlender Schluessel ist ein gescheiterter Read, kein bewiesenes "niemand".
  assert.match(reported(verifyReadback(clearing, {})), /kein Assignee/);
  assert.match(reported(verifyReadback(clearing, undefined)), /kein Assignee/);
  // Und ein tatsaechlich zugewiesener Vorgang darf nicht als geleert durchgehen.
  assert.match(reported(verifyReadback(clearing, { assignee: { accountId: "a1" } })), /erwartet niemand/);
  // Ein Objekt mit accountId null ist NICHT der bewiesene Leerstand: Jira meldet
  // einen nicht zugewiesenen Vorgang als assignee null, nicht als Objekt. Diese
  // Form gilt darum als unlesbar. Der Fall pinnt das "?? undefined" in
  // assigneeDifference, dessen Wegfall wie eine Vereinfachung aussaehe und einen
  // missgebildeten Read still als Erfolg durchgehen liesse.
  assert.match(reported(verifyReadback(clearing, { assignee: { accountId: null } })), /gelesen unlesbar/);
});

// OP-1372. A read parameter has no third state: absent and empty both mean
// "no choice made", and honouring the empty one would ask the site for nothing.
test("fieldListOr keeps the fallback for an absent and for an empty flag", () => {
  const fallback = ["summary", "status", "description", "creator", "attachment"];
  assert.deepEqual(fieldListOr(undefined, DEFAULT_ISSUE_FIELDS), fallback);
  assert.deepEqual(fieldListOr("", DEFAULT_ISSUE_FIELDS), fallback);
  assert.deepEqual(fieldListOr(" , ", DEFAULT_ISSUE_FIELDS), fallback);
  assert.deepEqual(fieldListOr("summary, assignee", DEFAULT_ISSUE_FIELDS), ["summary", "assignee"]);
});

// OP-1387. The body of a work item is part of the default read: a `get` that
// reports who wrote an item but not what it says sends the caller to a browser.
test("the default read asks for the description", () => {
  assert.ok(DEFAULT_ISSUE_FIELDS.includes("description"));
});

// OP-1396. Same argument one step further: a `get` that cannot say which files
// hang off a work item is why acceptance had to read them another way.
test("the default read asks for the attachments", () => {
  assert.ok(DEFAULT_ISSUE_FIELDS.includes("attachment"));
});

test("the write contract of parseFieldList is untouched: an empty flag still clears", () => {
  assert.deepEqual(parseFieldList(""), []);
  assert.equal(parseFieldList(undefined), null);
});

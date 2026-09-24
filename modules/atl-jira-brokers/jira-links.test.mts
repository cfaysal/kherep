import test from "node:test";
import assert from "node:assert/strict";

import {
  LINK_PATH,
  LINK_TYPE_CATALOG_PATH,
  confirmLinkCreated,
  confirmLinkRemoved,
  describeLink,
  findLinkIds,
  linkDeletePath,
  linkReadbackPath,
  linkRequestBody,
  parseLinkOptions,
  resolveLinkType,
  selectLinkToRemove,
} from "./jira-links.mts";

const CATALOG = {
  issueLinkTypes: [
    { id: "1000", name: "Duplicate", inward: "is duplicated by", outward: "duplicates" },
    { id: 1010, name: "Blocks", inward: "is blocked by", outward: "blocks" },
  ],
};

const DUPLICATE = resolveLinkType("Duplicate", CATALOG).type!;
const PLAN = parseLinkOptions({ type: "Duplicate", outward: "OP-1093", inward: "OP-827" }).plan!;

const counterpart = (extra: Record<string, unknown> = {}) => ({
  id: "10501",
  type: { id: "1000", name: "Duplicate", inward: "is duplicated by", outward: "duplicates" },
  inwardIssue: { key: "OP-827" },
  ...extra,
});

test("the documented paths are built, the link id is url-encoded", () => {
  assert.equal(LINK_TYPE_CATALOG_PATH, "/issueLinkType");
  assert.equal(LINK_PATH, "/issueLink");
  assert.equal(linkDeletePath("10501"), "/issueLink/10501");
  assert.equal(linkDeletePath("a/b"), "/issueLink/a%2Fb");
  assert.equal(linkReadbackPath("OP-1093"), "/issue/OP-1093?fields=issuelinks");
});

test("both keys and the type are mandatory, and each missing flag names itself", () => {
  assert.equal(parseLinkOptions({}).error, "--type fehlt.");
  assert.equal(parseLinkOptions({ type: "  " }).error, "--type fehlt.");
  assert.equal(parseLinkOptions({ type: "Duplicate", inward: "OP-827" }).error, "--outward fehlt.");
  assert.equal(parseLinkOptions({ type: "Duplicate", outward: "OP-1093" }).error, "--inward fehlt.");
  for (const result of [
    parseLinkOptions({ type: "Duplicate", outward: "nonsense", inward: "OP-827" }),
    parseLinkOptions({ type: "Duplicate", outward: "OP-1093", inward: "OP-0" }),
  ]) {
    assert.match(result.error!, /kein Vorgangsschlüssel/);
    assert.equal(result.plan, undefined);
  }
});

test("keys are normalized and an issue is never linked to itself", () => {
  assert.deepEqual(parseLinkOptions({ type: " Duplicate ", outward: " op-1093 ", inward: "op-827" }).plan, {
    typeName: "Duplicate",
    outwardKey: "OP-1093",
    inwardKey: "OP-827",
  });
  assert.match(parseLinkOptions({ type: "Duplicate", outward: "OP-5", inward: "op-5" }).error!, /mit sich selbst/);
});

test("a known type resolves to its catalog entry, a numeric id becomes a string", () => {
  assert.deepEqual(resolveLinkType("Blocks", CATALOG).type, {
    id: "1010", name: "Blocks", inward: "is blocked by", outward: "blocks",
  });
});

test("an unknown type is refused and the message names it plus the known ones", () => {
  const refused = resolveLinkType("Duplicates", CATALOG);
  assert.equal(refused.type, undefined);
  assert.match(refused.error!, /Unbekannter Verknüpfungstyp: Duplicates/);
  assert.match(refused.error!, /Duplicate, Blocks/);
});

test("an unreadable catalog is refused instead of treated as a site without types", () => {
  assert.match(resolveLinkType("Duplicate", null).error!, /Bekannt auf der Site: keine/);
  assert.match(resolveLinkType("Duplicate", {}).error!, /keine/);
});

test("the request body carries the resolved id and both roles as sent", () => {
  assert.deepEqual(linkRequestBody(DUPLICATE, PLAN), {
    type: { id: "1000" },
    outwardIssue: { key: "OP-1093" },
    inwardIssue: { key: "OP-827" },
  });
});

test("the direction is printed as the sentence the catalog spells out", () => {
  assert.equal(describeLink(DUPLICATE, PLAN), "OP-1093 duplicates OP-827");
  assert.equal(describeLink({ id: "1", name: "Relates", outward: null, inward: null }, PLAN), "OP-1093 Relates OP-827");
});

test("a matching entry on the outward issue yields its link id", () => {
  assert.deepEqual(findLinkIds({ issuelinks: [counterpart()] }, DUPLICATE, PLAN), { ids: ["10501"] });
});

test("the same pair written the wrong way round is not accepted as the link", () => {
  const reversed = { id: "10502", type: { id: "1000", name: "Duplicate" }, outwardIssue: { key: "OP-827" } };
  assert.deepEqual(findLinkIds({ issuelinks: [reversed] }, DUPLICATE, PLAN), { ids: [] });
  assert.match(confirmLinkCreated({ issuelinks: [reversed] }, DUPLICATE, PLAN).error!, /bestätigt die Verknüpfung nicht/);
});

test("a link of another type or to another issue does not match", () => {
  const others = [
    { id: "1", type: { id: "1010", name: "Blocks" }, inwardIssue: { key: "OP-827" } },
    { id: "2", type: { id: "1000", name: "Duplicate" }, inwardIssue: { key: "OP-999" } },
  ];
  assert.deepEqual(findLinkIds({ issuelinks: others }, DUPLICATE, PLAN), { ids: [] });
});

test("an entry that carries both sides matches only with both keys in their slots", () => {
  const full = counterpart({ outwardIssue: { key: "OP-1093" } });
  assert.deepEqual(findLinkIds({ issuelinks: [full] }, DUPLICATE, PLAN), { ids: ["10501"] });
  const foreign = counterpart({ outwardIssue: { key: "OP-4711" } });
  assert.deepEqual(findLinkIds({ issuelinks: [foreign] }, DUPLICATE, PLAN), { ids: [] });
});

test("a readback without the field is an error, an empty list is a measurement", () => {
  for (const fields of [undefined, null, {}, { issuelinks: null }]) {
    assert.match(findLinkIds(fields, DUPLICATE, PLAN).error!, /liefert keine Verknüpfungen/);
    assert.match(confirmLinkRemoved(fields, DUPLICATE, PLAN).error!, /liefert keine Verknüpfungen/);
    assert.match(selectLinkToRemove(fields, DUPLICATE, PLAN).error!, /liefert keine Verknüpfungen/);
  }
  assert.deepEqual(findLinkIds({ issuelinks: [] }, DUPLICATE, PLAN), { ids: [] });
  assert.deepEqual(confirmLinkRemoved({ issuelinks: [] }, DUPLICATE, PLAN), {});
});

test("the created link is confirmed with the id the caller never had to type", () => {
  assert.deepEqual(confirmLinkCreated({ issuelinks: [counterpart()] }, DUPLICATE, PLAN), { id: "10501" });
});

test("removal picks the one matching link and refuses when there is none", () => {
  assert.deepEqual(selectLinkToRemove({ issuelinks: [counterpart()] }, DUPLICATE, PLAN), { id: "10501" });
  const missing = selectLinkToRemove({ issuelinks: [] }, DUPLICATE, PLAN);
  assert.equal(missing.id, undefined);
  assert.match(missing.error!, /Keine passende Verknüpfung: OP-1093 duplicates OP-827/);
});

test("several matching links are reported instead of one being picked", () => {
  const ambiguous = selectLinkToRemove({ issuelinks: [counterpart(), counterpart({ id: "10502" })] }, DUPLICATE, PLAN);
  assert.equal(ambiguous.id, undefined);
  assert.match(ambiguous.error!, /Mehrere passende Verknüpfungen: 10501, 10502/);
});

test("a link that survives the delete is reported, not passed over", () => {
  assert.match(confirmLinkRemoved({ issuelinks: [counterpart()] }, DUPLICATE, PLAN).error!, /zeigt die Verknüpfung weiterhin/);
});

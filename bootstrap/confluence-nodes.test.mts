// Pure cover for the placement map: no credential, no network, no live space.
// The rows below are the shape bootstrap/confluence-nodes.mts reads out of the
// space index - (id, title, parentId) and nothing else.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { PLACEMENT_NODES, resolvePlacement, spaceFile } from "./confluence-nodes.mts";
import type { IndexedPage } from "../modules/atl-jira-brokers/confluence-related.mts";

const REPO = path.join(import.meta.dirname, "..");
// One rule, two files: each runtime's installer copies its OWN routing file to
// its own home, so a rule that exists in one of them reaches one runtime only.
// That is not hypothetical - the placement rule lived in the Claude file alone
// until OP-1421, and a Codex host had no instruction to place anything by.
const ROUTING = [
  path.join(REPO, "claude", "teams", "kherep", "ROUTING.md"),
  path.join(REPO, "codex", "ROUTING.md"),
];

function page(id: string, title: string, parentId: string | null): IndexedPage {
  return { id, title, parentId };
}

// The measured shape of this host's space on 2026-09-22: the prescribed
// hierarchy does not hang under the home page, it hangs one level further down
// under a node the rule never names.
const SPACE: IndexedPage[] = [
  page("1", "Kherep Brain", null),
  page("2", "CFcon", "1"),
  page("3", "Atlassian", "2"),
  page("4", "Development", "2"),
  page("5", "Kherep", "2"),
  page("6", "Operations", "2"),
  page("7", "DC Apps", "4"),
  page("8", "Forge Apps", "4"),
  page("9", "General", "4"),
  page("10", "Argus", "8"),
];

test("every prescribed node resolves through the intermediate node the rule never names", () => {
  const { nodes, missing } = resolvePlacement(SPACE);
  assert.deepEqual(missing, []);
  assert.deepEqual(nodes, {
    Atlassian: "3",
    Development: "4",
    "Development/DC Apps": "7",
    "Development/Forge Apps": "8",
    "Development/General": "9",
    Kherep: "5",
    Operations: "6",
  });
});

test("a later segment is looked for under its own parent, never in the space at large", () => {
  const twoGenerals = [...SPACE, page("11", "General", "3")];
  // Two pages called General, one of them under Atlassian. The path still means
  // the one under Development, and the other one is not a candidate at all.
  assert.equal(resolvePlacement(twoGenerals, ["Development/General"]).nodes["Development/General"], "9");
});

test("an absent node comes back as a name, not as an id", () => {
  const { nodes, missing } = resolvePlacement(SPACE, ["Development/Ops Apps", "Atlassian"]);
  assert.deepEqual(missing, ["Development/Ops Apps"]);
  assert.deepEqual(nodes, { Atlassian: "3" });
});

test("an ambiguous name resolves to nothing rather than to the first hit", () => {
  const twice = [...SPACE, page("12", "Operations", "1")];
  const { nodes, missing } = resolvePlacement(twice, ["Operations"]);
  assert.deepEqual(missing, ["Operations"], "two candidates are as unresolvable as none");
  assert.deepEqual(nodes, {});
});

test("an empty space resolves nothing and invents nothing", () => {
  const { nodes, missing } = resolvePlacement([]);
  assert.deepEqual(nodes, {});
  assert.deepEqual(missing, [...PLACEMENT_NODES]);
});

// The drift binding. The list in the code is the implementation of a rule
// written in prose, and the two live in different files: without this, a branch
// added to the rule would simply never be resolved on any host, silently.
test("the node list is exactly what the placement rule in ROUTING.md prescribes", () => {
  for (const file of ROUTING) {
    const routing = fs.readFileSync(file, "utf8");
    const rule = /Placement follows the content\.[\s\S]*?(?:\r?\n){2}/.exec(routing);
    assert.ok(rule, `${file} no longer contains a paragraph starting 'Placement follows the content.'`);
    const prescribed = new Set<string>();
    for (const [, quoted] of rule[0].matchAll(/`([^`]+)`/g)) {
      // The variable leaf is not a node name; everything above it is.
      const node = quoted.replace(/\/<[^>]+>$/, "");
      if (!/^[A-Z]/.test(node)) continue;
      const segments = node.split("/");
      for (let depth = 1; depth <= segments.length; depth += 1) {
        prescribed.add(segments.slice(0, depth).join("/"));
      }
    }
    assert.deepEqual([...prescribed].sort(), [...PLACEMENT_NODES].sort(), file);
  }
});

// The coarser half of the same binding. The rule above catches a node added to
// one file and not the other; this catches a whole SECTION added to one file
// and not the other, which is the shape the drift actually had: the Codex file
// carried neither "Session observations" nor "Linking" while the Claude file
// carried both. Section titles, not prose - the two files say the same things
// in their own runtime's paths and voice, and only the structure is identical.
test("both runtimes' routing files carry the same sections", () => {
  const sections = (file: string): string[] =>
    fs.readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.startsWith("## "));
  const [claude, codex] = ROUTING.map(sections);
  assert.deepEqual(codex, claude,
    "a section exists in one runtime's ROUTING.md and not the other's - it reaches one runtime only");
  for (const heading of ["## Session observations", "## Linking"]) {
    assert.ok(claude.includes(heading), `${heading} is missing from both routing files`);
  }
});

test("the persisted file keeps the three fields its readers already know", () => {
  const rendered = spaceFile({ key: "KB", id: "9001", name: "Knowledge" }, { Atlassian: "3" });
  assert.equal(rendered, `${JSON.stringify({
    spaceKey: "KB", spaceId: "9001", spaceName: "Knowledge", nodes: { Atlassian: "3" },
  }, null, 2)}\n`);
  // The two readers that exist today, checked through the file rather than by
  // restating their field names: the agent definition and orphan-check.sh.
  const parsed = JSON.parse(rendered) as { spaceKey: string; spaceId: string; spaceName: string };
  assert.equal(parsed.spaceKey, "KB");
  assert.equal(parsed.spaceId, "9001");
  assert.equal(parsed.spaceName, "Knowledge");
  assert.equal(rendered.endsWith("\n") && !rendered.endsWith("\n\n"), true);
});

test("both files stay under the size cap", () => {
  for (const file of [path.join(import.meta.dirname, "confluence-nodes.mts"),
    path.join(import.meta.dirname, "confluence-space.mts"), import.meta.filename]) {
    const lines = fs.readFileSync(file, "utf8").replace(/\n$/, "").split(/\r?\n/).length;
    assert.equal(lines <= 250, true, `${path.basename(file)} is ${lines} lines`);
  }
});

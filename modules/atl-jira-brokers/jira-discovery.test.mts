import assert from "node:assert/strict";
import test from "node:test";

import { JiraConfigError } from "./jira-config.mts";
import { discoverProject, type JiraGet } from "./jira-discovery.mts";

const PROJECT = { key: "OP", id: "10111" };
const TYPES = {
  issueTypes: [
    { id: "10000", name: "Epic" },
    { id: "10002", name: "Task" },
    { id: "10003", name: "Sub-task" },
  ],
};

function get(responses: Record<string, unknown>, seen: string[] = []): JiraGet {
  return async (path) => {
    seen.push(path);
    for (const [fragment, value] of Object.entries(responses)) {
      if (path.includes(fragment)) return value;
    }
    throw new Error(`unexpected path ${path}`);
  };
}

test("the project id and the creatable issue types are read from the site", async () => {
  const seen: string[] = [];
  const discovered = await discoverProject(
    get({ "/project/search": { values: [PROJECT] }, "/issue/createmeta": TYPES }, seen),
    "OP",
  );
  assert.equal(discovered.projectId, "10111");
  assert.deepEqual(discovered.issueTypes, { Epic: "10000", Task: "10002", "Sub-task": "10003" });
  // Both reads are scoped to the one key, so a service account with access to
  // many projects still cannot turn this into a site inventory.
  assert.equal(seen.length, 2);
  for (const path of seen) assert.match(path, /OP/);
});

test("a project key the account cannot see is refused instead of guessed", async () => {
  await assert.rejects(
    () => discoverProject(get({ "/project/search": { values: [] } }), "OP"),
    (error: unknown) => error instanceof JiraConfigError && /OP/.test(error.message),
  );
});

// The search endpoint matches keys loosely enough to return neighbours; only an
// exact key may be adopted, or the broker would file into the wrong project.
test("a near miss in the search result is not adopted", async () => {
  await assert.rejects(
    () => discoverProject(get({ "/project/search": { values: [{ key: "OPS", id: "10999" }] } }), "OP"),
    JiraConfigError,
  );
});

test("a non numeric project id is refused", async () => {
  await assert.rejects(
    () => discoverProject(get({ "/project/search": { values: [{ key: "OP", id: "abc" }] } }), "OP"),
    JiraConfigError,
  );
});

test("a project without creatable types is refused rather than bound to an empty map", async () => {
  await assert.rejects(
    () => discoverProject(
      get({ "/project/search": { values: [PROJECT] }, "/issue/createmeta": { issueTypes: [] } }),
      "OP",
    ),
    JiraConfigError,
  );
});

test("malformed rows are skipped and the remaining types still bind", async () => {
  const discovered = await discoverProject(
    get({
      "/project/search": { values: ["noise", null, PROJECT] },
      "/issue/createmeta": { issueTypes: [{ id: "x", name: "Bad" }, { id: "10002", name: " Task " }, { name: "NoId" }] },
    }),
    "OP",
  );
  assert.deepEqual(discovered.issueTypes, { Task: "10002" });
});

test("the alternative values envelope is read the same way", async () => {
  const discovered = await discoverProject(
    get({ "/project/search": { values: [PROJECT] }, "/issue/createmeta": { values: [{ id: "10004", name: "Bug" }] } }),
    "OP",
  );
  assert.deepEqual(discovered.issueTypes, { Bug: "10004" });
});

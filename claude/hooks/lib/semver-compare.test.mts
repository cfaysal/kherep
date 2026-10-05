import assert from "node:assert/strict";
import test from "node:test";

import { compareSemver } from "./semver-compare.mts";

test("reports a newer running worker above the installed pin", () => {
  assert.ok(compareSemver("13.12.4", "13.11.2") > 0);
});

test("reports an older running worker below the installed pin", () => {
  assert.ok(compareSemver("13.10.9", "13.11.2") < 0);
});

test("treats equivalent versions as equal", () => {
  assert.equal(compareSemver("13.11.2", "13.11.2"), 0);
});

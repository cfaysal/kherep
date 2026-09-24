"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { compareSemver } = require("./semver-compare");

test("reports a newer running worker above the installed pin", () => {
  assert.ok(compareSemver("13.12.4", "13.11.2") > 0);
});

test("reports an older running worker below the installed pin", () => {
  assert.ok(compareSemver("13.10.9", "13.11.2") < 0);
});

test("treats equivalent versions as equal", () => {
  assert.equal(compareSemver("13.11.2", "13.11.2"), 0);
});

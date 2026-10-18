import assert from "node:assert/strict";
import { test } from "node:test";

import { withoutTypeStrippingWarning } from "./node-warning-fixture.mts";

const BLOCK = (pid: number) => `(node:${pid}) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time\n`
  + "(Use `node --trace-warnings ...` to show where the warning was created)\n";

test("removes only the type-stripping warning block, at most max times", () => {
  const foreign = "(node:7) ExperimentalWarning: SYNTHETIC_UNRELATED_WARNING\n(Use `node --trace-warnings ...` to show where the warning was created)\n";
  const deprecation = "(node:8) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.\n";
  const stderr = `${BLOCK(5)}${foreign}hook line\n${BLOCK(6)}${deprecation}${BLOCK(9)}`;

  assert.equal(withoutTypeStrippingWarning(stderr, 2), `${foreign}hook line\n${deprecation}${BLOCK(9)}`);
  assert.equal(withoutTypeStrippingWarning(stderr, 3), `${foreign}hook line\n${deprecation}`);
  assert.equal(withoutTypeStrippingWarning(stderr, 0), stderr);
  assert.equal(withoutTypeStrippingWarning(`${BLOCK(5).split("\n")[0]}\nline\n`, 1), "line\n", "the trace hint is optional");
});

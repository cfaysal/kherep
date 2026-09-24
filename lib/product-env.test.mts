import assert from "node:assert/strict";
import test from "node:test";

import { productEnv } from "./product-env.mts";

test("canonical product variables are returned even when explicitly empty", () => {
  assert.equal(productEnv({ KHEREP_SAMPLE: "new" }, "SAMPLE"), "new");
  assert.equal(productEnv({ KHEREP_SAMPLE: "" }, "SAMPLE"), "");
});

test("unrelated environment variables are ignored", () => {
  assert.equal(productEnv({ OTHER_VENDOR_SAMPLE: "old" }, "SAMPLE"), undefined);
  assert.equal(productEnv({}, "SAMPLE"), undefined);
});

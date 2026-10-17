import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publishOutcome } from "./service-reclaim-outcome-fixture.mts";

function fixture(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-reclaim-outcome-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "outcome");
}

for (const value of ["owned", "blocked"]) {
  test(`outcome publication hides an incomplete write: ${value}`, t => {
    const outcome = fixture(t), write = fs.writeFileSync;
    const mocked = t.mock.method(fs, "writeFileSync", (...[file, data, options]: Parameters<typeof fs.writeFileSync>) => {
      assert.ok(typeof file === "string");
      const handle = fs.openSync(file, "wx", 0o600);
      try {
        assert.equal(fs.existsSync(outcome), false, "the reader must not see an empty final outcome");
        write(handle, data, options);
      } finally { fs.closeSync(handle); }
    });
    try { publishOutcome(outcome, value); }
    finally { mocked.mock.restore(); }
    assert.equal(fs.readFileSync(outcome, "utf8"), value);
    assert.equal(fs.existsSync(`${outcome}.pending`), false);
  });
}

for (const initial of ["preexisting", "published"]) {
  test(`outcome publication preserves an existing result: ${initial}`, t => {
    const outcome = fixture(t);
    if (initial === "preexisting") fs.writeFileSync(outcome, "owned", { flag: "wx" });
    else publishOutcome(outcome, "owned");
    const before = fs.readFileSync(outcome);
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.throws(() => publishOutcome(outcome, "blocked"), { code: "EEXIST" });
      assert.deepEqual(fs.readFileSync(outcome), before);
      assert.equal(fs.existsSync(`${outcome}.pending`), false);
    }
  });
}

test("outcome publication preserves an existing staging file", t => {
  const outcome = fixture(t), staged = `${outcome}.pending`;
  fs.writeFileSync(staged, "synthetic in-progress result", { flag: "wx" });
  assert.throws(() => publishOutcome(outcome, "blocked"), { code: "EEXIST" });
  assert.equal(fs.readFileSync(staged, "utf8"), "synthetic in-progress result");
  assert.equal(fs.existsSync(outcome), false);
});

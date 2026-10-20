// Issue #521, path 2: the disk fills during a repair. ENOSPC is simulated, never
// real: through restore-write.mts's own writeChunk seam, through a patch of the
// node:fs default export in this process (the writer hold of
// hook-runtime-fault-fixture.mts), and through the fault preload in exactly one
// admitted reader (fault-preload.fixture.mts). A write that touched the target
// reports `write failed (ENOSPC)`, keeps its intent pending and is never retried
// in the same run; no reader loads the partial file; the next admitted run
// without the fault completes it. A target that was absent stays absent and its
// staging file is dropped. A heartbeat that cannot be written leaves no file.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { writeExact } from "../kherep/hook-runtime/recovery/restore-write.mts";
import { faultEnv, fired } from "./fault-preload.fixture.mts";
import { cleanup, entry, runtimeHome } from "./hook-runtime-fixture.mts";
import { encode, enospc, GOOD, heartbeatOf, heldWriter, integrityRun, pendingRows, text } from "./hook-runtime-fault-fixture.mts";

after(cleanup);
const BYTES = encode(GOOD);
const PREFIX = GOOD.slice(0, 8);
const notRestored = (lines: string[], rel: string): string | undefined =>
  lines.find((line) => line.startsWith(`${rel}: `))?.split(" -> ")[1];
const staging = (dir: string): string[] =>
  fs.readdirSync(dir, { recursive: true }).map(String).filter((name) => name.includes("kherep-tmp"));
const chunkFault = (calls: { n: number }) => ({ writeChunk: (fd: number, bytes: Uint8Array, offset: number, length: number): number => {
  calls.n++;
  fs.writeSync(fd, bytes, offset, Math.min(length, 8));
  throw Object.assign(new Error("injected"), { code: "ENOSPC" });
} });

test("P2 unit: ENOSPC in place leaves the written prefix and names the code only", () => {
  const home = runtimeHome();
  const file = path.join(home.hooks, "guard.mts");
  fs.writeFileSync(file, "old\n");
  const ino = fs.statSync(file, { bigint: true }).ino;
  const calls = { n: 0 };
  assert.equal(writeExact(file, BYTES, home.hooks, chunkFault(calls)), "write failed (ENOSPC)");
  assert.equal(calls.n, 1);
  assert.equal(text(file), PREFIX, "the same inode holds a prefix: its intent must stay pending");
  assert.equal(fs.statSync(file, { bigint: true }).ino, ino);
});

test("P2 unit: ENOSPC while an absent target is published leaves it absent and no staging file", () => {
  const home = runtimeHome();
  const file = path.join(home.hooks, "guard.mts");
  const calls = { n: 0 };
  assert.equal(writeExact(file, BYTES, home.hooks, chunkFault(calls), "absent"), "write failed (ENOSPC); the target was not touched");
  assert.equal(calls.n, 1);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(staging(home.hooks), []);
});

for (const [label, times] of [["persistent", Infinity], ["one-shot", 1]] as const) {
  test(`P2 hold: a ${label} ENOSPC in place reports the write failure, keeps the intent and does not retry`, async (t) => {
    const { home, guards: [guard], hold } = await heldWriter();
    const fault = enospc(t, times);
    const result = await hold.repair("guard.mts", BYTES);
    fault.restore();
    assert.deepEqual(result, { proven: false, why: "write failed (ENOSPC)" });
    assert.equal(fault.fired(), 1, "one write of the target, no second replay in the same run");
    assert.equal(hold.holding(), false);
    assert.equal(text(guard!), PREFIX);
    hold.end();
    assert.equal(await pendingRows(home), 1);
    assert.equal(entry("reader", guard!).stdout, "ran", "the next admitted run completes the recorded bytes");
    assert.equal(await pendingRows(home), 0);
  });
}

test("P2 hook: ENOSPC during an integrity run; no reader loads the prefix until a run without the fault completes it", async (t) => {
  const held = await heldWriter(["guard.mts", "guard2.mts"], { integrity: true });
  const { home, guards: [guard, guard2], hold } = held;
  const fault = enospc(t);
  const lines = await integrityRun(held);
  fault.restore();
  assert.equal(fault.fired(), 1);
  assert.equal(notRestored(lines, "guard.mts"), "NOT restored (write failed (ENOSPC)). ENFORCEMENT IS OFF for this hook.", lines.join("\n"));
  assert.equal(notRestored(lines, "guard2.mts"),
    "NOT restored (the exclusive hold on the hooks directory was lost). ENFORCEMENT IS OFF for this hook.");
  assert.equal(lines.at(-1), "heartbeat not written (guard.mts is not restored)");
  assert.doesNotMatch(lines.join("\n"), /injected|Error:|errno/);
  assert.equal(heartbeatOf(held), null);
  hold.end();
  assert.equal(text(guard!), PREFIX);
  assert.equal(text(guard2!), "");
  assert.equal(await pendingRows(home), 1);

  const mark = path.join(home.root, "fault-fired");
  const blocked = entry("pretool", guard!, [], "{}", 40_000, faultEnv("fs-enospc", "guard.mts", mark));
  assert.deepEqual(fired(mark), ["fs-enospc"]);
  assert.equal(blocked.stdout, JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: "[hook-entry] guard.mts cannot run (not admitted: recovery); the tool call is blocked until hook integrity restores it" } }));
  assert.equal(blocked.stderr, "");
  assert.equal(text(guard!), PREFIX, "the replay failed again; the guard never ran");
  assert.equal(await pendingRows(home), 1);
  assert.equal(entry("reader", guard!).stdout, "ran");
  assert.equal(text(guard!), GOOD);
  assert.equal(await pendingRows(home), 0);
  assert.deepEqual(staging(home.hooks), []);
});

test("P2 heartbeat: ENOSPC on the heartbeat leaves neither a heartbeat nor its temporary file", async (t) => {
  const held = await heldWriter(["guard.mts"], { integrity: true });
  const real = fs.writeFileSync;
  let failed = 0;
  t.mock.method(fs, "writeFileSync", (file: unknown, ...rest: unknown[]) => {
    if (/heartbeat\.json\..*\.tmp$/.test(String(file))) {
      failed++;
      throw Object.assign(new Error("injected"), { code: "ENOSPC" });
    }
    return (real as (...args: unknown[]) => void)(file, ...rest);
  });
  const lines = await integrityRun(held);
  held.hold.end();
  assert.equal(failed, 1);
  assert.match(lines[0] ?? "", /^guard\.mts: .* -> RESTORED from the repo, verified at the target/, lines.join("\n"));
  assert.equal(lines.at(-1), "heartbeat not written (heartbeat write failed: ENOSPC)");
  assert.equal(heartbeatOf(held), null);
  const dir = path.join(held.home.root, ".cache", "hook-integrity");
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
});

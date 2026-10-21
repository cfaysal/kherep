// Issue #507, part 3. In its installed layout (<home>/hooks/kherep-maestro) the
// Codex hook adapter re-checks hook integrity after its guards when the heartbeat
// is stale or missing, or a guard could not run; its lines never change the
// decision. Each case copies the adapter as codex-hook-adapter.mts with the real
// lib/guard-recheck.mts and a copy of the shell dispatcher (its peer, issue #507
// part 4) beside a synthetic codex-hook-integrity.mts that traces argv, stdin and
// CODEX_HOME, restores every 0-byte or `export const broken = ;` .mts beside it
// (from a pristine copy when there is one) and writes the heartbeat with the
// peers record. No real hook, home or checkout is involved.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { copyAdapter } from "./hook-adapter.fixture.mts";

const MIN = 60_000;
const REPO = path.resolve(import.meta.dirname, "..", "..");
const PAYLOAD = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "shell_command", tool_input: { command: "git status ü" } });
const GOOD = "process.exit(0);\n";
const BROKEN = "export const broken = ;\n";

// The peers record of heartbeat.json (issue #507, part 4): one bigint stat per
// dispatcher file present. The fake integrity hook embeds this function's source.
function peersOf(dir: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const name of ["codex-hook-adapter.mts", "hook-adapter.mts", "codex-shell-checks.mts"]) {
    try {
      const s = fs.statSync(path.join(dir, name), { bigint: true });
      out[name] = { dev: String(s.dev), ino: String(s.ino), size: String(s.size), mtimeNs: String(s.mtimeNs), sha256: "fixture" };
    } catch { /* not present: no record */ }
  }
  return out;
}

// Constant program text: the fake writes its trace into CODEX_HOME.
const INTEGRITY = `import fs from "node:fs";
import path from "node:path";
const home = process.env.CODEX_HOME;
const dir = path.join(home, "hooks", "kherep-maestro");
fs.appendFileSync(path.join(home, "trace.jsonl"), JSON.stringify({ argv: process.argv.slice(2), input: fs.readFileSync(0, "utf8"), home }) + "\\n");
let restored = 0;
for (const name of fs.readdirSync(dir)) {
  const file = path.join(dir, name);
  if (!name.endsWith(".mts") || !fs.statSync(file).isFile()) continue;
  const text = fs.readFileSync(file, "utf8");
  if (text.length && !text.startsWith("export const broken = ;")) continue;
  const pristine = path.join(home, "pristine", name);
  if (fs.existsSync(pristine)) fs.copyFileSync(pristine, file); else fs.writeFileSync(file, "process.exit(0);\\n");
  restored++;
  console.log(name + ": " + (text.length ? "broken" : "0 bytes") + " -> RESTORED from the repo, verified at the target (sha256 0123456789ab)");
}
fs.mkdirSync(path.join(home, ".cache", "hook-integrity"), { recursive: true });
fs.writeFileSync(path.join(home, ".cache", "hook-integrity", "heartbeat.json"), JSON.stringify({ peers: (${peersOf.toString()})(dir) }) + "\\n");
console.log("all 2 files OK (" + restored + " restored), heartbeat refreshed");
`;
const GUARDS: Record<string, string> = {
  "allow.mts": GOOD,
  "json-deny.mts": "process.stdout.write(JSON.stringify({ hookSpecificOutput: "
    + "{ hookEventName: \"PreToolUse\", permissionDecision: \"deny\", permissionDecisionReason: \"json says no\" } }));\n",
};

interface Box { root: string; dir: string; adapter: string; peer: string; trace: string; beat: string }

// A heartbeat ageMs old whose peers record the files as they are now, or `body` verbatim.
function writeBeat(b: Pick<Box, "dir" | "beat">, ageMs: number, body?: string): void {
  fs.mkdirSync(path.dirname(b.beat), { recursive: true });
  fs.writeFileSync(b.beat, body ?? `${JSON.stringify({ peers: peersOf(b.dir) })}\n`);
  const then = new Date(Date.now() - ageMs);
  fs.utimesSync(b.beat, then, then);
}

// heartbeatAgeMs null: no heartbeat at all.
function box(t: TestContext, heartbeatAgeMs: number | null): Box {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-adapter-recheck-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "hooks", "kherep-maestro");
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "pristine"));
  const adapter = path.join(dir, "codex-hook-adapter.mts");
  copyAdapter(dir, "codex-hook-adapter.mts");
  const peer = path.join(dir, "codex-shell-checks.mts");
  fs.copyFileSync(path.join(import.meta.dirname, "shell-checks.mts"), peer);
  fs.copyFileSync(peer, path.join(root, "pristine", "codex-shell-checks.mts"));
  fs.copyFileSync(path.join(REPO, "claude", "hooks", "lib", "guard-recheck.mts"), path.join(dir, "lib", "guard-recheck.mts"));
  fs.writeFileSync(path.join(dir, "codex-hook-integrity.mts"), INTEGRITY);
  for (const [name, source] of Object.entries(GUARDS)) fs.writeFileSync(path.join(dir, name), source);
  const beat = path.join(root, ".cache", "hook-integrity", "heartbeat.json");
  if (heartbeatAgeMs !== null) writeBeat({ dir, beat }, heartbeatAgeMs);
  return { root, dir, adapter, peer, trace: path.join(root, "trace.jsonl"), beat };
}

interface Printed { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string }
interface Run { stdout: string; stderr: string; output?: Printed; systemMessage?: string; ms: number }

function call(b: Box, guard: string): Run {
  const begin = Date.now();
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", b.adapter, path.join(b.dir, guard), "pre"],
    { input: PAYLOAD, encoding: "utf8", windowsHide: true, timeout: 12_000 });
  const ms = Date.now() - begin;
  assert.equal(run.status, 0, `adapter exit ${run.status}; stderr ${run.stderr}`);
  const parsed = run.stdout ? JSON.parse(run.stdout) as { hookSpecificOutput: Printed; systemMessage?: string } : undefined;
  return { stdout: run.stdout, stderr: run.stderr, output: parsed?.hookSpecificOutput, systemMessage: parsed?.systemMessage, ms };
}

const traced = (b: Box): { argv: string[]; input: string; home: string }[] => fs.existsSync(b.trace)
  ? fs.readFileSync(b.trace, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];

test("a heartbeat 29 minutes old: no re-check, no output", (t) => {
  const b = box(t, 29 * MIN);
  assert.equal(call(b, "allow.mts").stdout, "");
  assert.deepEqual(traced(b), []);
});

test("a heartbeat 31 minutes old: one re-check with --trigger hook-adapter, the exact payload and CODEX_HOME, no decision", (t) => {
  const b = box(t, 31 * MIN);
  const lastOk = new Date(fs.statSync(b.beat).mtimeMs).toISOString();
  const run = call(b, "allow.mts");
  assert.deepEqual(traced(b), [{ argv: ["--trigger", "hook-adapter"], input: PAYLOAD, home: b.root }]);
  assert.equal(run.output?.permissionDecision, undefined, run.stdout);
  assert.equal(run.output?.additionalContext, `hook integrity re-check (stale heartbeat, last OK ${lastOk}):\n`
    + "  - all 2 files OK (0 restored), heartbeat refreshed");
  assert.ok(run.stderr.includes(String(run.output?.additionalContext)), "the block also goes to stderr");
  assert.ok(Date.now() - fs.statSync(b.beat).mtimeMs < MIN, "the heartbeat mtime moved");
});

test("no heartbeat: re-checked with last OK none", (t) => {
  const b = box(t, null);
  const run = call(b, "allow.mts");
  assert.equal(traced(b).length, 1);
  // No heartbeat is no peers record either (issue #507, part 4): the peer line comes first.
  assert.match(String(run.output?.additionalContext),
    /^kherep-maestro\/codex-shell-checks\.mts cannot be trusted \(no proven record\)\nhook integrity re-check \(no heartbeat, last OK none\):\n {2}- all 2 files OK/);
});

test("a stale heartbeat next to a policy deny: the deny and its reason stay, systemMessage and stderr carry the block", (t) => {
  const b = box(t, 31 * MIN);
  const run = call(b, "json-deny.mts");
  assert.equal(run.output?.permissionDecision, "deny");
  assert.equal(run.output?.permissionDecisionReason, "json says no");
  assert.match(String(run.systemMessage), /^Kherep hook integrity: hook integrity re-check \(stale heartbeat, last OK [^)]+\): \(\+1 more\)$/);
  assert.match(run.stderr, /hook integrity re-check \(stale heartbeat, .*\n {2}- all 2 files OK \(0 restored\), heartbeat refreshed/);
});

for (const [label, age, why] of [["stale", 31 * MIN, "stale heartbeat"], ["fresh", 0, "guard failure"]] as const) {
  test(`${label} heartbeat, empty guard: this call stays denied, the next runs the restored guard`, (t) => {
    const b = box(t, age);
    fs.writeFileSync(path.join(b.dir, "empty.mts"), "");
    const first = call(b, "empty.mts");
    assert.equal(first.output?.permissionDecision, "deny");
    assert.ok(String(first.output?.permissionDecisionReason).includes("empty.mts cannot run (empty, 0 bytes)"));
    assert.ok(String(first.systemMessage).startsWith(`Kherep hook integrity: hook integrity re-check (${why}, last OK `), first.systemMessage);
    assert.ok(first.stderr.includes("empty.mts: 0 bytes -> RESTORED"), first.stderr);
    assert.equal(fs.readFileSync(path.join(b.dir, "empty.mts"), "utf8"), GOOD);
    const second = call(b, "empty.mts");
    assert.equal(second.stdout, "", "allow, no re-check");
    assert.equal(traced(b).length, 1, "no further re-check");
  });
}

test("an unrunnable codex-hook-integrity.mts is named and spawns nothing", (t) => {
  const b = box(t, 31 * MIN);
  const script = path.join(b.dir, "codex-hook-integrity.mts");
  fs.writeFileSync(script, "");
  const run = call(b, "json-deny.mts");
  assert.equal(run.output?.permissionDecisionReason, "json says no");
  assert.ok(run.stderr.includes("kherep-maestro/codex-hook-integrity.mts cannot run (empty, 0 bytes)"), run.stderr);
  assert.deepEqual(traced(b), []);
});

test("an empty lib/guard-recheck.mts is one unavailable line; the verdict is unchanged", (t) => {
  const b = box(t, 31 * MIN);
  fs.writeFileSync(path.join(b.dir, "lib", "guard-recheck.mts"), "");
  const run = call(b, "json-deny.mts");
  assert.equal(run.output?.permissionDecisionReason, "json says no");
  assert.match(run.stderr, /hook integrity re-check unavailable \(lib\/guard-recheck\.mts cannot be loaded \(TypeError\)\)/);
  assert.deepEqual(traced(b), []);
});

test("a lib whose import never settles: one unavailable line within 2 s, the deny stays", (t) => {
  const b = box(t, 31 * MIN);
  fs.writeFileSync(path.join(b.dir, "lib", "guard-recheck.mts"), "await new Promise(() => {});\n");
  const run = call(b, "json-deny.mts");
  assert.ok(run.ms < 5000, `took ${run.ms} ms`);
  assert.equal(run.output?.permissionDecisionReason, "json says no");
  assert.match(run.stderr, /hook integrity re-check unavailable \(lib\/guard-recheck\.mts did not load within 2000 ms\)/);
});

// T1.7 (design §7): the adapter exits right after its output, even when something it
// loaded leaves a handle open; the checkout layout has nothing that could.
test("T1.7 a re-check lib that leaves a handle open: the adapter still exits right after its output", (t) => {
  const b = box(t, 31 * MIN);
  fs.writeFileSync(path.join(b.dir, "lib", "guard-recheck.mts"), "export const heartbeatState = () => ({ stale: true });\n"
    + "export const recheckNotice = (_c, lines) => lines.join(\"\\n\");\n"
    + "export async function runRecheck() { setInterval(() => {}, 1000); return \"re-check fixture left an interval\"; }\n");
  const run = call(b, "allow.mts");
  assert.ok(run.ms < 3000, `took ${run.ms} ms`);
  assert.equal(run.output?.additionalContext, "re-check fixture left an interval");
});

test("a re-check that outlives its 6 s budget is killed and reported as UNKNOWN; the adapter ends before 10 s", (t) => {
  const b = box(t, 31 * MIN);
  fs.writeFileSync(path.join(b.dir, "codex-hook-integrity.mts"), "setInterval(() => {}, 1000);\n");
  const run = call(b, "allow.mts");
  assert.ok(run.ms < 10_000, `took ${run.ms} ms`);
  assert.match(String(run.output?.additionalContext), /\n {2}- timed out after \d+ ms; outcome UNKNOWN \(a heartbeat may have been written\)$/);
  assert.equal(run.output?.permissionDecision, undefined);
});

// Issue #507, part 4. The adapter's peer gate: codex-shell-checks.mts is proven only
// as the bytes the last integrity run recorded in heartbeat.json "peers".
const runs = (b: Box): number => traced(b).length;
const restoredPeer = (b: Box): boolean => fs.readFileSync(b.peer).equals(fs.readFileSync(path.join(b.root, "pristine", "codex-shell-checks.mts")));
const firstLine = (run: Run): string => String(run.output?.additionalContext).split("\n")[0]!;

test("T10a a fresh heartbeat, the peer emptied: allow, one run naming it, restored, then quiet", (t) => {
  const b = box(t, 0);
  fs.writeFileSync(b.peer, "");
  const run = call(b, "allow.mts");
  assert.equal(run.output?.permissionDecision, undefined, run.stdout);
  assert.equal(firstLine(run), "kherep-maestro/codex-shell-checks.mts cannot be trusted (empty, 0 bytes)");
  assert.ok(restoredPeer(b));
  assert.equal(call(b, "allow.mts").stdout, "");
  assert.equal(runs(b), 1);
});

for (const sameSize of [true, false]) {
  test(`T10b a fresh heartbeat, the peer syntax-broken ${sameSize ? "at the same size" : "at another size"}: the changed field is named, restored, then quiet`, (t) => {
    const b = box(t, 0);
    const size = fs.statSync(b.peer).size;
    fs.writeFileSync(b.peer, sameSize ? `${BROKEN}//${"x".repeat(size - BROKEN.length - 2)}` : BROKEN);
    assert.equal(fs.statSync(b.peer).size === size, sameSize);
    const run = call(b, "allow.mts");
    assert.equal(firstLine(run), `kherep-maestro/codex-shell-checks.mts cannot be trusted (${sameSize ? "mtime" : "size"} changed since the last proven check)`);
    assert.ok(restoredPeer(b));
    assert.equal(call(b, "allow.mts").stdout, "");
    assert.equal(runs(b), 1);
  });
}

test("T10c a fresh heartbeat, the peer untouched: no run", (t) => {
  const b = box(t, 0);
  assert.equal(call(b, "allow.mts").stdout, "");
  assert.equal(runs(b), 0);
});

for (const swap of ["hard link", "symlink"] as const) {
  test(`T10d/e a ${swap} swap to an old broken file: the inode differs, one run`, (t) => {
    const b = box(t, 0);
    const old = path.join(b.root, "old-broken.mts");
    fs.writeFileSync(old, BROKEN);
    const then = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(old, then, then);
    fs.rmSync(b.peer);
    if (swap === "hard link") fs.linkSync(old, b.peer);
    else {
      // A host without the symlink privilege refuses with EPERM at symlink; skip only
      // that, as the other symlink tests do, and CI proves the case (issue #534).
      try {
        fs.symlinkSync(old, b.peer);
      } catch (error) {
        const { code, syscall } = error as NodeJS.ErrnoException;
        if (code !== "EPERM" || syscall !== "symlink") throw error;
        t.skip("symlink creation unavailable (EPERM)");
        return;
      }
    }
    assert.ok(fs.statSync(b.peer).mtimeMs < fs.statSync(b.beat).mtimeMs, "older than the heartbeat");
    const run = call(b, "allow.mts");
    assert.equal(firstLine(run), "kherep-maestro/codex-shell-checks.mts cannot be trusted (inode changed since the last proven check)");
    assert.equal(runs(b), 1);
  });
}

for (const [label, body] of [["no record of this peer", '{"peers":{"hook-adapter.mts":{}}}\n'], ["malformed JSON", "{peers"]] as const) {
  test(`T10f a fresh heartbeat with ${label}: one run (no proven record)`, (t) => {
    const b = box(t, null);
    writeBeat(b, 0, body);
    const run = call(b, "allow.mts");
    assert.equal(firstLine(run), "kherep-maestro/codex-shell-checks.mts cannot be trusted (no proven record)");
    assert.equal(runs(b), 1);
    assert.equal(call(b, "allow.mts").stdout, "", "the run recorded the peer");
  });
}

test("T12 residual: an in-place same-size rewrite with the recorded mtime is not seen until the heartbeat is stale", (t) => {
  const b = box(t, null);
  const when = new Date(Math.floor(Date.now() / 1000) * 1000 - 5000);
  fs.utimesSync(b.peer, when, when);
  writeBeat(b, 0);
  const { ino, size } = fs.statSync(b.peer);
  fs.writeFileSync(b.peer, `${BROKEN}//${"x".repeat(size - BROKEN.length - 2)}`);
  fs.utimesSync(b.peer, when, when);
  assert.deepEqual([fs.statSync(b.peer).ino, fs.statSync(b.peer).size], [ino, size], "same inode, same size");
  assert.equal(call(b, "allow.mts").stdout, "", "the gate is blind to this rewrite by design (named residual)");
  assert.equal(runs(b), 0);
  const stale = new Date(Date.now() - 31 * MIN);
  fs.utimesSync(b.beat, stale, stale);
  assert.match(String(call(b, "allow.mts").output?.additionalContext), /^hook integrity re-check \(stale heartbeat/);
  assert.ok(restoredPeer(b), "the stale-heartbeat run restores it");
});

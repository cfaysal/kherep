import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type test from "node:test";

// Issue #436. Synthetic config roots, pins and receipts for the launcher tests.
// Nothing here touches a real config root: every root is a fresh mkdtemp.

export const RECORD_ENV = "KHEREP_LAUNCHER_TEST_RECORD";

// A stub Control Plane CLI: names its pin, echoes its argv, records that it ran
// and exits 7, so a test can see which pin the launcher chose and that the
// child's exit code came back unchanged.
export function stubCli(marker: string): string {
  return [
    'import fs from "node:fs";',
    `if (process.env.${RECORD_ENV}) fs.appendFileSync(process.env.${RECORD_ENV}, ${JSON.stringify(`${marker}\n`)});`,
    `process.stdout.write(JSON.stringify({ pin: ${JSON.stringify(marker)}, argv: process.argv.slice(2) }));`,
    "process.exit(7);",
    "",
  ].join("\n");
}

// A temporary config root whose path contains a space, like the macOS default.
export function tempRoot(t: test.TestContext, prefix = "kherep-launcher-"): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "Application Support", "kherep");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export function makePin(root: string, commit: string, marker: string, options: { cli?: boolean; manifest?: boolean } = {}): string {
  const pin = path.join(root, "control-plane", "service", "source-pins", commit);
  fs.mkdirSync(path.join(pin, "modules", "control-plane", "node"), { recursive: true });
  if (options.manifest !== false) fs.writeFileSync(path.join(pin, ".kherep-source.json"), "{}\n");
  if (options.cli !== false) fs.writeFileSync(path.join(pin, "modules", "control-plane", "node", "cli.mts"), stubCli(marker));
  return pin;
}

export function receiptFor(pin: string, commit: string, nodeExecutable = process.execPath, kind = "pin"): unknown {
  return { version: 1, binding: { nodeExecutable,
    source: { root: pin, commit, digest: "d".repeat(64), kind, verified: true } } };
}

export function receiptPath(root: string): string {
  return path.join(root, "control-plane", "service", "receipt.json");
}

export function writeReceipt(root: string, value: unknown): void {
  fs.mkdirSync(path.dirname(receiptPath(root)), { recursive: true });
  fs.writeFileSync(receiptPath(root), typeof value === "string" ? value : JSON.stringify(value));
}

// Every file of <root>/bin with its bytes, for before/after comparisons.
export function launcherBytes(root: string): Record<string, string> {
  const dir = path.join(root, "bin");
  return Object.fromEntries(fs.readdirSync(dir).sort().map(name => [name, fs.readFileSync(path.join(dir, name), "utf8")]));
}

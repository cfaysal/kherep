// The repair passes and the publication of one integrity run (issue #507, part 2).
//
// Runs inside the hold the hook runtime gives live-hook-integrity.mts: the
// integrity writer is admitted EXCLUSIVE before it loads anything, every
// repair is recorded durably before its first byte (kherep/hook-runtime), and
// the hold is taken again after it. Without that hold, from another hooks
// directory or next to a wired command that runs hooks/ code outside the
// runtime (`gate`), files are checked and reported but nothing is repaired,
// journalled or published. The heartbeat is removed before the first repair
// and written only after the final read-only proof (integrity-proof.mts),
// within one uninterrupted hold. At most three passes repair what the
// previous one brought in; a fourth walk only checks that nothing is left
// (integrity-passes.mts, shared with the Codex hook since #507 part 3).
// Static imports: node:* only; the libs arrive as a parameter.
import fs from "node:fs";

import type { HookFile, InventoryEntry, SourceText } from "./hook-inventory.mts";
import type { Outcome } from "./integrity-passes.mts";
import type { Repairer, Restored } from "./integrity-verdict.mts";
import type { ScopePayload } from "./workspace-scope.mts";

export type RunLibs = typeof import("./integrity-verdict.mts") & typeof import("./workspace-scope.mts")
  & typeof import("./orchestra-checkout.mts") & typeof import("./hook-inventory.mts") & typeof import("./hook-syntax.mts")
  & typeof import("./integrity-heartbeat.mts") & typeof import("./integrity-proof.mts") & typeof import("./integrity-passes.mts");
export interface WriterHold extends Repairer { root: string; holding: () => boolean; end: () => void }
export interface Run {
  lib: RunLibs; hold: WriterHold | null; gate: string; files: HookFile[]; notes: string[]; lines: string[];
  payload: ScopePayload | null; home: string; trigger: string; plain: boolean;
  // Test seam: pauses the run between the final proof and the heartbeat. It takes
  // nothing and returns nothing; it cannot substitute a check, the hold, the root or
  // the heartbeat. Production (live-hook-integrity.mts) never sets it.
  probe?: { beforeHeartbeat?: () => Promise<void> | void };
}
const LOST = "the exclusive hold on the hooks directory was lost";

export async function runIntegrity(run: Run): Promise<void> {
  const { lib, hold, gate, files, notes, lines, payload, home, trigger, plain } = run;
  let unproven = notes.length ? "the live settings were not read completely" : gate;
  const state = { invalidated: false, blocked: "" };
  const repoRoot = lib.checkoutFor(payload, home);
  // The walk reads the live file, and the versioned one when the live file is
  // gone or empty, so one broken link does not hide the files behind it. A live
  // file is named by its real path, so its imports resolve where Node loads them
  // from (issue #524); this walk is no proof, the final proof below is the gate.
  const hooksDir = `${home}/hooks`;
  let realHooks = hooksDir;
  try { realHooks = fs.realpathSync(hooksDir); } catch { /* the wired spelling */ }
  const readSource = (file: string, rel: string): string | SourceText | null => {
    for (const candidate of [file, repoRoot && lib.joinPathLike(repoRoot, `claude/hooks/${rel}`)]) {
      let text = "";
      try { text = candidate ? fs.readFileSync(candidate, "utf8") : ""; } catch { /* next candidate */ }
      if (!text) continue;
      if (candidate !== file) return text;
      try { return { text, real: fs.realpathSync(file) }; } catch { return { text }; }
    }
    return null;
  };
  const passes = await lib.repairPasses({
    walk: () => lib.hookInventory(files, hooksDir, readSource, realHooks),
    checkOne: (entry) => checkOne(run, entry, repoRoot, state),
  });
  unproven ||= passes.unproven;
  const { restored } = passes;
  if (!unproven && !hold?.holding()) unproven = LOST;
  let count = passes.inventory.length;
  if (!unproven) ({ why: unproven, count } = await lib.finalProof(lib, home, hold!.root, files));
  await run.probe?.beforeHeartbeat?.();
  if (!unproven) unproven = lib.writeHeartbeat(home, { trigger, runtime: "claude", files: count });
  if (plain) lines.push(unproven ? `heartbeat not written (${unproven})` : `all ${count} files OK (${restored} restored), heartbeat refreshed`);
}

// One file: its verdict, a coordinated repair when DEFEKT, the journal; `unproven` is "" when it ended OK.
async function checkOne(run: Run, entry: InventoryEntry, repoRoot: string, state: { invalidated: boolean; blocked: string }): Promise<Outcome> {
  const { lib, hold, gate, lines, home, trigger } = run;
  const { file, rel, wired, importedBy } = entry;
  const { state: verdict, reason, before = {} } = await lib.classify(lib, file, wired ? "wired" : "imported");
  if (verdict === "OK") return { unproven: "", restored: false };
  const label = importedBy.length ? `${rel} (imported by ${importedBy.join(", ")})` : rel;
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(), trigger, file: rel, path: file, state: verdict, reason,
    kind: wired ? "wired" : "import", importedBy,
    sizeBefore: before.size === undefined ? null : before.size,
    mtimeBefore: before.mtime || null,
    inoBefore: before.ino === undefined ? null : before.ino,
    sha256After: null, restoreProven: false,
  };
  // A journal line is a mutation too: only inside the coordinated hold.
  const journal = (): void => { if (!gate && hold?.holding()) lib.journal(home, record); };
  if (verdict === "UNGEPRUEFT") {
    lines.push(`${label}: UNCHECKED - ${reason}. Neither proven healthy nor proven broken.`);
    journal();
    return { unproven: `${rel} is unchecked`, restored: false };
  }
  let result: Restored;
  if (gate) result = { proven: false, why: gate };
  else if (!hold?.holding()) result = { proven: false, why: LOST };
  else {
    if (!state.invalidated) {
      state.invalidated = true;
      state.blocked = lib.invalidateHeartbeat(home);
    }
    result = state.blocked ? { proven: false, why: state.blocked } : await lib.restore(lib, hold, file, rel, repoRoot);
  }
  record.sha256After = result.sha || null;
  record.restoreProven = result.proven;
  if (!result.proven) record.restoreDetail = result.why;
  journal();
  lines.push(
    result.proven
      ? `${label}: ${reason} -> RESTORED from the repo, verified at the target (sha256 ${result.sha!.slice(0, 12)})`
      : `${label}: ${reason} -> NOT restored (${result.why}). ENFORCEMENT IS OFF for this hook.`
  );
  if (!result.proven) return { unproven: `${rel} is not restored`, restored: false };
  // Proven bytes, re-checked as the loader will see them.
  const after = (await lib.classify(lib, file, "restored")).state;
  if (after !== "OK") lines.push(`${label}: still ${after} after the restore`);
  return { unproven: after === "OK" ? "" : `${rel} is not OK after the restore`, restored: true };
}

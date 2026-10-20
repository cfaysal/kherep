// The repair passes both integrity hooks share (issue #507, part 3):
// live-hook-integrity.mts through integrity-run.mts, and the Codex hook
// codex/hooks/hook-integrity.mts. Runtime-neutral: the walk and the check of one
// file arrive as functions, so this file knows no hold, lock, restore or journal.
//
// A restore changes what a file imports, so the closure is walked again after
// each pass; at most three passes repair, a fourth walk only confirms that
// nothing new is left. finalPass is the Codex hook's last read-only walk; the
// Claude hook keeps integrity-proof.mts for that.
// Static imports: types only, nothing from node:*.
import type { InventoryEntry } from "./hook-inventory.mts";

export type Outcome = { unproven: string; restored: boolean };
export interface Passes { walk: () => InventoryEntry[]; checkOne: (entry: InventoryEntry) => Promise<Outcome>; maxPasses?: number }
export const NOT_SETTLED = "the import closure did not settle";

// Each pass checks what the previous ones did not see. `unproven` is the first
// text that is not empty, in the order the files were checked, or NOT_SETTLED when
// pass maxPasses still finds new files; `inventory` is the last walk.
export async function repairPasses(p: Passes): Promise<{ inventory: InventoryEntry[]; unproven: string; restored: number }> {
  const seen = new Set<string>();
  let unproven = "";
  let restored = 0;
  let inventory: InventoryEntry[] = [];
  for (let pass = 0; ; pass++) {
    inventory = p.walk();
    const fresh = inventory.filter((entry) => !seen.has(entry.rel));
    if (!fresh.length) break;
    if (pass === (p.maxPasses ?? 3)) { unproven ||= NOT_SETTLED; break; }
    for (const entry of fresh) {
      seen.add(entry.rel);
      const outcome = await p.checkOne(entry);
      unproven ||= outcome.unproven;
      if (outcome.restored) restored++;
    }
  }
  return { inventory, unproven, restored };
}

// One more walk, over live bytes only: every file must classify OK and the walk
// must find exactly the files of `expected`. "" when it did.
export async function finalPass(p: {
  walk: () => InventoryEntry[]; classify: (entry: InventoryEntry) => Promise<{ state: string }>; expected: InventoryEntry[];
}): Promise<string> {
  const inventory = p.walk();
  for (const entry of inventory) {
    if ((await p.classify(entry)).state !== "OK") return `${entry.rel} is not OK in the final check`;
  }
  const expected = new Set(p.expected.map((entry) => entry.rel));
  if (inventory.length !== expected.size || inventory.some((entry) => !expected.has(entry.rel))) return NOT_SETTLED;
  return "";
}

import fs from "node:fs";
import path from "node:path";

import { legacyDaemonArguments, managedArguments } from "./service-definitions.mts";
import { MAC_EXECUTABLE_PROBE, PID_PATH_JXA, type MacCommand } from "./service-platform-mac-native.mts";
import type { ServiceBinding } from "./service-types.mts";

// Process identity reads that do not consult launchd (#677). `ps -o lstart=` under the C locale is
// "Thu Oct 23 10:00:00 2026", the day of month space-padded below 10.
const LSTART = String.raw`[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}`;
const IDENTITY_ROW = new RegExp(String.raw`^\s*(${LSTART})\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S.*)$`, "u");
const INVENTORY_ROW = new RegExp(String.raw`^\s*([1-9]\d*)\s+(\d+)\s+(\d+)\s+(\d+)\s+(${LSTART})\s(.*)$`, "u");
const cLocale = (): NodeJS.ProcessEnv => ({ ...process.env, LANG: "C", LC_ALL: "C" });
const safe = (value: string): number | null => Number.isSafeInteger(Number(value)) ? Number(value) : null;

export interface MacProcessIdentity { lstart: string; uid: number; pgid: number; ppid: number; command: string; executable: string }
export interface MacProcessRow { pid: number; ppid: number; pgid: number; uid: number; lstart: string; command: string }

// One `ps` row and the executable path of the same pid (proc_pidpath). Null on any read or parse failure.
export function readMacProcessIdentity(run: MacCommand, pid: number): MacProcessIdentity | null {
  const listed = run("ps", ["-ww", "-p", String(pid), "-o", "lstart=,uid=,pgid=,ppid=,command="], 15_000, cLocale());
  if (listed.error || listed.status !== 0 || listed.stdout.includes("\0")) return null;
  const lines = listed.stdout.split("\n").filter(Boolean);
  const row = lines.length === 1 ? IDENTITY_ROW.exec(lines[0]) : null;
  if (!row) return null;
  const [uid, pgid, ppid] = [safe(row[2]), safe(row[3]), safe(row[4])];
  if (uid === null || pgid === null || ppid === null) return null;
  const probed = run(MAC_EXECUTABLE_PROBE, ["-l", "JavaScript", "-e", PID_PATH_JXA, String(pid)]);
  const executable = probed.stdout.trim();
  if (probed.error || probed.status !== 0 || !path.isAbsolute(executable) || executable.includes("\0")) return null;
  return { lstart: row[1], uid, pgid, ppid, command: row[5].trimEnd(), executable };
}

export interface MacIdentityExpectation { uid: number; binding: ServiceBinding; startedAt: string; sourceRoot?: string; lstart?: string }

// The selected daemon: this user, the binding's Node executable, one of the two daemon argv forms, started within
// 60 s of the recorded start, and (when given) the exact `lstart` read before bootout.
export function macIdentityMatches(identity: MacProcessIdentity, expected: MacIdentityExpectation): boolean {
  if (identity.uid !== expected.uid || (expected.lstart !== undefined && identity.lstart !== expected.lstart)) return false;
  try {
    if (fs.realpathSync.native(identity.executable) !== fs.realpathSync.native(expected.binding.nodeExecutable)) return false;
  } catch { return false; }
  const node = expected.binding.nodeExecutable;
  const forms = [[node, ...managedArguments(expected.binding)],
    [node, ...legacyDaemonArguments(expected.binding, expected.sourceRoot ?? expected.binding.source.root)]];
  const created = Date.parse(identity.lstart);
  return forms.some(argv => identity.command === argv.join(" "))
    && Number.isFinite(created) && Math.abs(Date.parse(expected.startedAt) - created) <= 60_000;
}

// The complete process table with group and start time. Null when unreadable, empty or not parseable as a whole.
export function readMacInventory(run: MacCommand): MacProcessRow[] | null {
  const inventory = run("ps", ["-ww", "-axo", "pid=,ppid=,pgid=,uid=,lstart=,command="], 15_000, cLocale());
  if (inventory.error || inventory.status !== 0 || inventory.stderr !== "" || inventory.stdout.includes("\0")) return null;
  const rows: MacProcessRow[] = [];
  for (const line of inventory.stdout.split("\n").filter(Boolean)) {
    const row = INVENTORY_ROW.exec(line);
    const [pid, ppid, pgid, uid] = row ? [safe(row[1]), safe(row[2]), safe(row[3]), safe(row[4])] : [null, null, null, null];
    if (!row || pid === null || ppid === null || pgid === null || uid === null) return null;
    rows.push({ pid, ppid, pgid, uid, lstart: row[5], command: row[6] });
  }
  return rows.length ? rows : null;
}

// Every pid below `root` by ppid, `root` excluded (the closure the stop preflight also applies).
export function macDescendants(pairs: ReadonlyArray<readonly [number, number]>, root: number): Set<number> {
  const seen = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [child, parent] of pairs) if (seen.has(parent) && !seen.has(child)) { seen.add(child); changed = true; }
  }
  seen.delete(root);
  return seen;
}

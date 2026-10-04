import { execFileSync } from "node:child_process";

import { holdsChild, signalGroup, signalProcess, startTimeOf, type CodexDeps, type SignalScope } from "./codex-process.mts";

export interface ProcessIdentity { pid: number; start: string }
export interface ProcessRelation { pid: number; ppid: number }

// The descendants that belong to root at the stop boundary. Start identities
// make a later reused pid a different process, never another kill target.
export function processTree(deps: CodexDeps, root: number): ProcessIdentity[] {
  if (deps.processTree) return deps.processTree(root);
  const platform = deps.platform ?? process.platform;
  const rootStart = startTimeOf(deps, root);
  if (rootStart === null) return [];
  const relations = deps.processRelations?.() ?? (platform === "win32" ? windowsRelations() : posixRelations());
  const descendants = new Set<number>([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of relations) {
      if (!descendants.has(row.ppid) || descendants.has(row.pid)) continue;
      descendants.add(row.pid);
      changed = true;
    }
  }
  const identities: ProcessIdentity[] = [];
  for (const pid of descendants) {
    const start = startTimeOf(deps, pid);
    if (start !== null) identities.push({ pid, start });
  }
  return identities;
}

function posixRelations(): ProcessRelation[] {
  const text = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 10_000 });
  return parseRelations(text);
}

const timedOut = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";

// Toolhelp32 takes one process snapshot without WMI/CIM administrator access.
// Issue #221: on a loaded windows-latest runner the cold powershell.exe start
// with its Add-Type compile hit the 10 s limit, so a timeout alone runs once
// more (execFileSync returns only after the killed child exited); any other
// failure throws at once.
export function windowsRelations(run: () => string = queryWindowsRelations): ProcessRelation[] {
  let text: string;
  try {
    text = run();
  } catch (error) {
    if (!timedOut(error)) throw error;
    text = run();
  }
  return parseRelations(text);
}

function queryWindowsRelations(): string {
  const command = String.raw`
$source = @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class KherepProcessTree {
  const uint SnapshotProcesses = 2;
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct ProcessEntry {
    public uint size, usage, pid;
    public IntPtr heap;
    public uint module, threads, parentPid;
    public int priority;
    public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string executable;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32FirstW(IntPtr snap, ref ProcessEntry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32NextW(IntPtr snap, ref ProcessEntry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static string Rows() {
    IntPtr snap = CreateToolhelp32Snapshot(SnapshotProcesses, 0);
    if (snap == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      var entry = new ProcessEntry();
      entry.size = (uint)Marshal.SizeOf(entry);
      var rows = new StringBuilder();
      if (!Process32FirstW(snap, ref entry)) {
        int error = Marshal.GetLastWin32Error();
        if (error != 18) throw new Win32Exception(error);
        return rows.ToString();
      }
      do {
        rows.Append(entry.pid).Append(' ').Append(entry.parentPid).Append('\n');
        entry.size = (uint)Marshal.SizeOf(entry);
      } while (Process32NextW(snap, ref entry));
      int lastError = Marshal.GetLastWin32Error();
      if (lastError != 18) throw new Win32Exception(lastError);
      return rows.ToString();
    } finally { CloseHandle(snap); }
  }
}
"@
Add-Type -TypeDefinition $source
[KherepProcessTree]::Rows()
`;
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 });
}

function parseRelations(text: string): ProcessRelation[] {
  return text.trim().split("\n").flatMap((line) => {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    return Number.isInteger(pid) && Number.isInteger(ppid) ? [{ pid, ppid }] : [];
  });
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

function allStopped(deps: CodexDeps, identities: ProcessIdentity[]): boolean {
  return identities.every(({ pid, start }) => startTimeOf(deps, pid) !== start);
}

async function waitStopped(deps: CodexDeps, identities: ProcessIdentity[], timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  do {
    if (allStopped(deps, identities)) return true;
    await pause(Math.min(25, Math.max(1, until - Date.now())));
  } while (Date.now() < until);
  return allStopped(deps, identities);
}

type Send = (pid: number, signal: NodeJS.Signals, scope: SignalScope) => void;

function sender(deps: CodexDeps): Send {
  return deps.signal ?? ((target, signal, scope) => {
    if (scope === "process") return signalProcess(target, signal, deps.platform);
    const sent = signalGroup(target, signal, deps.platform);
    // Windows taskkill /T reports failure when descendants require /F; that is
    // the expected first phase, followed by the bounded forced phase below.
    if (!sent && !((deps.platform ?? process.platform) === "win32" && signal === "SIGTERM")) {
      throw new Error("could not send " + signal + " to process tree");
    }
  });
}

// One stop phase. Issue #231: Codex runs shell commands in their own process
// group, which the signal to the root's group misses, and the root can end
// before them. So the group (the tree on Windows) is signalled while the root
// is still the captured process, and then, by pid, each captured descendant
// that still has its captured start time; a reused pid is never signalled.
// Returns why something got no signal or a send failed; the wait that follows
// decides whether the tree stopped.
function signalPhase(deps: CodexDeps, root: ProcessIdentity, identities: ProcessIdentity[], signal: NodeJS.Signals): string[] {
  const send = sender(deps);
  const notes: string[] = [];
  const attempt = (pid: number, scope: SignalScope): void => {
    try {
      send(pid, signal, scope);
    } catch (error) {
      notes.push(signal + (scope === "group" ? " to the group of pid " : " to pid ") + pid + " failed: "
        + String((error as Error).message ?? error));
    }
  };
  const current = startTimeOf(deps, root.pid);
  if (current === root.start) attempt(root.pid, "group");
  else notes.push("root process " + (current === null ? "ended" : "was reused") + " before " + signal);
  for (const { pid, start } of identities) {
    if (pid !== root.pid && startTimeOf(deps, pid) === start) attempt(pid, "process");
  }
  return notes;
}

// Capture the exact process tree and each pid's start identity, signal its OS
// group/tree and each verified descendant, SIGTERM and then SIGKILL, and
// return only after every captured identity ended. A failed read, or a tree
// that outlives SIGKILL, remains an error, so callers cannot report a guessed stop.
// Issue #221: a ps or PowerShell helper that hit its time limit must not leave
// the tree running. If the root is still the recorded process, its tree is
// forced (SIGKILL; taskkill /T /F on Windows), and the stop still fails, since
// no captured identity was confirmed ended; a later watch round settles the run.
export async function terminate(deps: CodexDeps, pid: number, pidStart: string | undefined): Promise<void> {
  try {
    await terminateTree(deps, pid, pidStart);
  } catch (error) {
    if (!timedOut(error)) throw error;
    let outcome: string;
    try {
      const recorded = pidStart === undefined ? holdsChild(pid) : startTimeOf(deps, pid) === pidStart;
      if (recorded) {
        sender(deps)(pid, "SIGKILL", "group");
        outcome = "its process tree was forced to stop, the stop is not confirmed";
      } else {
        outcome = "the root is no longer the recorded process, so nothing was forced";
      }
    } catch (forceError) {
      outcome = "forcing its process tree failed: " + String((forceError as Error).message ?? forceError);
    }
    throw new Error(String((error as Error).message ?? error) + "; " + outcome, { cause: error });
  }
}

async function terminateTree(deps: CodexDeps, pid: number, pidStart: string | undefined): Promise<void> {
  if (pidStart === undefined && !holdsChild(pid)) throw new Error("process identity unknown");
  const identities = processTree(deps, pid);
  const root = identities.find((entry) => entry.pid === pid);
  if (!root || (pidStart !== undefined && root.start !== pidStart)) {
    if (allStopped(deps, identities)) return;
    throw new Error("root process identity changed during capture while captured processes still run");
  }
  const grace = deps.graceMs ?? 5_000;
  signalPhase(deps, root, identities, "SIGTERM");
  if (await waitStopped(deps, identities, grace)) return;
  const notes = signalPhase(deps, root, identities, "SIGKILL");
  if (!await waitStopped(deps, identities, grace)) throw new Error(["process tree did not stop after SIGKILL", ...notes].join("; "));
}

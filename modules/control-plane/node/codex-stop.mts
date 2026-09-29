import { execFileSync } from "node:child_process";

import { holdsChild, signalGroup, startTimeOf, type CodexDeps } from "./codex-process.mts";

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

// Toolhelp32 takes one process snapshot without WMI/CIM administrator access.
function windowsRelations(): ProcessRelation[] {
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
  const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  return parseRelations(text);
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

function rootCanBeSignalled(deps: CodexDeps, root: ProcessIdentity, identities: ProcessIdentity[], signal: NodeJS.Signals): boolean {
  const current = startTimeOf(deps, root.pid);
  if (current === root.start) return true;
  if (allStopped(deps, identities)) return false;
  const reason = current === null ? "ended" : "was reused";
  throw new Error("root process " + reason + " before " + signal + " while captured descendants still run");
}

// Capture the exact process tree and each pid's start identity, signal its OS
// group/tree, and return only after every captured identity ended. A failed
// read or signal remains an error, so callers cannot report a guessed stop.
export async function terminate(deps: CodexDeps, pid: number, pidStart: string | undefined): Promise<void> {
  if (pidStart === undefined && !holdsChild(pid)) throw new Error("process identity unknown");
  const identities = processTree(deps, pid);
  const root = identities.find((entry) => entry.pid === pid);
  if (!root || (pidStart !== undefined && root.start !== pidStart)) {
    if (allStopped(deps, identities)) return;
    throw new Error("root process identity changed during capture while captured processes still run");
  }
  const send = deps.signal ?? ((target, signal) => {
    const sent = signalGroup(target, signal, deps.platform);
    // Windows taskkill /T reports failure when descendants require /F; that is
    // the expected first phase, followed by the bounded forced phase below.
    if (!sent && !((deps.platform ?? process.platform) === "win32" && signal === "SIGTERM")) {
      throw new Error("could not send " + signal + " to process tree");
    }
  });
  const grace = deps.graceMs ?? 5_000;
  if (!rootCanBeSignalled(deps, root, identities, "SIGTERM")) return;
  try {
    send(pid, "SIGTERM");
  } catch (error) {
    if (allStopped(deps, identities)) return;
    throw error;
  }
  if (await waitStopped(deps, identities, grace)) return;
  if (!rootCanBeSignalled(deps, root, identities, "SIGKILL")) return;
  try {
    send(pid, "SIGKILL");
  } catch (error) {
    if (allStopped(deps, identities)) return;
    throw error;
  }
  if (!await waitStopped(deps, identities, grace)) throw new Error("process tree did not stop after SIGKILL");
}

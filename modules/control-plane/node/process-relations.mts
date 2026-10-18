import { children } from "./child-run.mts";
import { timedAsync } from "./sync-timing.mts";

// The parent of every process, for the process tree of a stop (moved from
// codex-stop.mts, which re-exports it). Issue #473: the listing is an awaited
// child process (child-run.mts); its command and output are unchanged.

export interface ProcessRelation { pid: number; ppid: number }

export async function posixRelations(): Promise<ProcessRelation[]> {
  const text = await timedAsync("process-relations", () => children.run("ps", ["-eo", "pid=,ppid="],
    { env: { ...process.env, LC_ALL: "C" }, timeoutMs: 10_000 }));
  return parseRelations(text);
}

export const timedOut = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";

// Toolhelp32 takes one process snapshot without WMI/CIM administrator access.
// Issue #221: on a loaded windows-latest runner the cold powershell.exe start
// with its Add-Type compile hit the 10 s limit, so a timeout alone runs once
// more (the runner settles only after the killed child exited); any other
// failure throws at once.
export async function windowsRelations(run: () => Promise<string> = queryWindowsRelations): Promise<ProcessRelation[]> {
  let text: string;
  try {
    text = await run();
  } catch (error) {
    if (!timedOut(error)) throw error;
    text = await run();
  }
  return parseRelations(text);
}

function queryWindowsRelations(): Promise<string> {
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
  return timedAsync("process-relations", () => children.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
    { timeoutMs: 10_000 }));
}

function parseRelations(text: string): ProcessRelation[] {
  return text.trim().split("\n").flatMap((line) => {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    return Number.isInteger(pid) && Number.isInteger(ppid) ? [{ pid, ppid }] : [];
  });
}

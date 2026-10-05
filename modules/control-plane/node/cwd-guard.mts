import type { DirectoryBody } from "../protocol-messages.mts";

// Issue #240: `msg send <node> --new ... --cwd <dir>` refuses, before any
// request is written, a directory that cannot be a path on the target node.
// The target refuses such a start anyway ("cwd does not exist on this node"),
// but only after the request went out.

export type PathStyle = "windows" | "posix";

// Git for Windows (MSYS) rewrites a POSIX-looking argument such as /Users/x
// into <its install directory>/Users/x before the CLI sees it.
// The default, per-user and Scoop install directories.
const MSYS_PREFIX =
  /^[A-Za-z]:[\\/](?:Program Files(?: \(x86\))?[\\/]Git|Users[\\/][^\\/]+[\\/](?:AppData[\\/]Local[\\/]Programs[\\/]Git|scoop[\\/]apps[\\/]git[\\/]current))(?:[\\/]|$)/i;
export const MSYS_HINT = "run the command from PowerShell, or set MSYS_NO_PATHCONV=1 in Git Bash";

function styleOf(p: string): PathStyle | null {
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("//")) return "windows";
  return p.startsWith("/") ? "posix" : null;
}

// A node's path style, from the working directories of its sessions in the
// directory; null when it lists none or they disagree.
export function nodePathStyle(directory: DirectoryBody, nodeId: string): PathStyle | null {
  const styles = new Set(directory.sessions.filter((s) => s.nodeId === nodeId && typeof s.cwd === "string")
    .map((s) => styleOf(s.cwd!)));
  return styles.size === 1 ? [...styles][0]! : null;
}

// Why cwd cannot be a directory on the target, or null. Without a known path
// style for the target only the MSYS rule applies.
export function cwdProblem(cwd: string, targetName: string, targetStyle: PathStyle | null): string | null {
  if (MSYS_PREFIX.test(cwd)) return `--cwd "${cwd}" looks rewritten by Git Bash path conversion; ${MSYS_HINT}`;
  const style = styleOf(cwd);
  if (targetStyle === "posix" && style === "windows") {
    return `--cwd "${cwd}" is a Windows path, but ${targetName} uses POSIX paths; pass a path on ${targetName} (${MSYS_HINT})`;
  }
  if (targetStyle === "windows" && style === "posix") {
    return `--cwd "${cwd}" is a POSIX path, but ${targetName} uses Windows paths; pass a drive path on ${targetName}`;
  }
  return null;
}

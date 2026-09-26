// Issue #75. Git Bash names a drive as /d/..., and a settings env block written
// from Git Bash hands that form to every Node tool. On Windows, path.resolve
// reads it as a path on the current drive: /d/Work becomes D:\d\Work. Convert a
// single-letter MSYS drive prefix to the native drive before resolving. Every
// other value, and every value on a POSIX host, passes through unchanged.
//
// modules/local-inference/lib/profile.mts carries a copy, because that lib is
// projected on its own; lib/workspace-path.test.mts keeps the two in step.
export function nativeWorkspacePath(value: string, platform: string = process.platform): string {
  if (platform !== "win32") return value;
  const drive = value.match(/^\/([A-Za-z])(\/.*)?$/);
  return drive ? `${drive[1].toUpperCase()}:${(drive[2] || "/").replace(/\//g, "\\")}` : value;
}

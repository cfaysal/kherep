// Shared ACL fixture of restore-write-acl.test.mts and hook-runtime-replay.test.mts
// (issue #507, part 2). An in-place write keeps the inode's access-control list, so
// these cases put an ACL on the target leaf only and compare two reads of that same
// file, one before and one after the product call. A read that failed, came back
// partial or came back empty is null and fails the case: no ACL is ever inferred from
// silence. Windows: icacls sets the ACL for the current user's SID, resolved at run
// time; one complete Get-Acl snapshot (the Access SDDL and AreAccessRulesProtected)
// reads it; nothing skips. macOS chmod +a / ls -le and Linux setfacl / getfacl as
// before; there a missing tool or a root user skips the case.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";

const WIN = process.platform === "win32";
const system32 = (...rest: string[]): string => path.join(process.env.SystemRoot || "C:\\Windows", "System32", ...rest);
const sh = (cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, env });
const posixTool = process.platform === "darwin" ? "chmod" : process.platform === "linux" ? "setfacl" : "";

let sidOnce = "";
function userSid(): string {
  if (!sidOnce) {
    const out = sh(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
    const sid = out.status === 0 ? /"(S-1-\d+(?:-\d+)+)"\s*$/.exec(out.stdout.trim())?.[1] : undefined;
    if (!sid) assert.fail(`the current user's SID could not be read (whoami exit ${out.status})`);
    sidOnce = sid;
  }
  return sidOnce;
}

const SNAPSHOT = "$ProgressPreference = 'SilentlyContinue'; try { $a = Get-Acl -LiteralPath $env:KHEREP_ACL_PATH -ErrorAction Stop; "
  + "$a.GetSecurityDescriptorSddlForm('Access'); $a.AreAccessRulesProtected } catch { exit 3 }";

// The ACL of file, or null when the read failed or is not complete.
export function readAcl(file: string): string | null {
  if (WIN) {
    // Windows PowerShell builds its own module path; one inherited from PowerShell 7
    // points at modules it cannot load, and Get-Acl would never autoload.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"));
    const out = sh(system32("WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", SNAPSHOT],
      { ...env, KHEREP_ACL_PATH: path.resolve(file) });
    const lines = out.stdout.split(/\r?\n/).filter((line) => line.trim());
    if (out.status !== 0 || out.stderr || lines.length !== 2) return null;
    const [access, protectedRules] = lines as [string, string];
    if (!/^D:[A-Z]*(\([^()]+\))+$/.test(access) || !/^(True|False)$/.test(protectedRules)) return null;
    if ((protectedRules === "True") !== /^D:[A-Z]*P/.test(access)) return null;
    return `${access}\nprotected=${protectedRules}`;
  }
  if (process.platform === "darwin") {
    const out = sh("ls", ["-le", file]);
    return lsAcl(out.status, out.stdout);
  }
  const out = sh("getfacl", ["-cp", file]);
  return out.status === 0 && out.stdout.trim() ? out.stdout : null;
}

// macOS `ls -le <file>`: the long-listing line, then one line per ACE ("<n>: ..."). Only a
// run that exited 0 with that line and at least one ACE line, nothing else, is a read: ls
// prints the listing line alone both for a file without an ACL and when it could not read
// the ACL (file_cmds ls.c, acl_get_link_np), so no ACE proves nothing and is null. The
// cases give every file they compare an ACE. Neither the listing line nor its mode flag
// (@ or +) is part of the ACL.
export function lsAcl(status: number | null, stdout: string): string | null {
  const lines = stdout.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const [head, ...aces] = lines;
  if (status !== 0 || !head || !/^[-bcdlps][-rwxsStT]{9}[@+]?\s/.test(head)) return null;
  if (aces.some((line) => !/^\s*\d+: \S/.test(line))) return null;
  return aces.length ? aces.join("\n") : null;
}

// The code a write open of file fails with under this process's token, "" when it opens.
export function writeOpenError(file: string): string {
  try {
    fs.closeSync(fs.openSync(file, fs.constants.O_WRONLY));
    return "";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code || "unknown";
  }
}

function setAcl(file: string, deny: boolean): boolean {
  if (WIN) {
    const sid = userSid();
    const args = deny ? [file, "/deny", `*${sid}:(WD,AD)`]
      : [file, "/inheritance:r", "/grant:r", `*${sid}:(R,W)`, "/grant", "*S-1-5-32-545:(R)"];
    return sh(system32("icacls.exe"), args).status === 0;
  }
  // A POSIX ACL grants the file owner through its owner entry (u::), never through a
  // named entry for the same user, so the Linux deny case narrows u:: and keeps a
  // named entry and the mask, which makes the ACL an extended one.
  return sh(posixTool, process.platform === "darwin" ? ["+a", `group:everyone ${deny ? "deny write" : "deny delete"}`, file]
    : ["-m", deny ? "u::r--,u:nobody:r--,m::r--" : "u:nobody:r--", file]).status === 0;
}

function resetAcl(file: string): boolean {
  if (WIN) return sh(system32("icacls.exe"), [file, "/reset"]).status === 0;
  return sh(posixTool, process.platform === "darwin" ? ["-N", file] : ["-b", file]).status === 0;
}

// true only when file is proven gone (ENOENT), not when it merely could not be seen.
function removed(file: string): boolean {
  try {
    fs.lstatSync(file);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export interface Applied { before: string; denied: string }

// Puts a restricting or a write-denying ACL on file, proves it took effect, and returns
// it as read back with the code a write open now fails with ("" when restricting).
// null when this platform cannot run the case (never on Windows).
export function applyAcl(t: TestContext, file: string, deny: boolean): Applied | null {
  if (!WIN && (!posixTool || process.getuid?.() === 0)) {
    t.skip("no ACL tool for this platform");
    return null;
  }
  // Before the first change, which may land half: a leaf that is still there is lifted
  // and checked, so the tree can go; one whose removal was proven needs nothing.
  let lift = true;
  t.after(() => { if (lift && !removed(file)) liftAcl(file); });
  if (!setAcl(file, deny)) {
    if (WIN) assert.fail(`icacls could not set the ${deny ? "deny" : "restricting"} ACL`);
    lift = false; // the POSIX tool refused the entry: nothing to lift
    t.skip("no ACL tool for this platform");
    return null;
  }
  const before = readAcl(file);
  if (!before) assert.fail("the ACL could not be read completely before the call");
  if (WIN) {
    const ace = new RegExp(`\\(${deny ? "D" : "A"};[^;()]*;[^;()]+;;;${userSid()}\\)`);
    // Booleans and fixed messages only: no SDDL and no SID reaches any assertion output.
    assert.ok(ace.test(before), `the ${deny ? "deny" : "allow"} ACE for the current user is in place`);
    assert.ok(before.endsWith(deny ? "\nprotected=False" : "\nprotected=True"), "the inheritance is as set");
    if (!deny) assert.ok(!/\([AD];[^;()]*ID/.test(before), "no inherited ACE is left");
  }
  const denied = writeOpenError(file);
  if (deny) assert.ok(denied === "EPERM" || denied === "EACCES", `a write open under the deny ACL is refused, got ${denied || "an open file"}`);
  else assert.equal(denied, "", "a write open under the restricting ACL succeeds");
  fs.readFileSync(file); // the file stays readable
  return { before, denied };
}

// The ACL of file is still the one read before the call.
export function sameAcl(file: string, before: string): void {
  const now = readAcl(file);
  if (!now) assert.fail("the ACL could not be read completely after the call");
  assert.ok(now === before, "the ACL is the one read before the call");
}

// Lifts the ACL and proves it is gone: on Windows the inherited ACL is back and no
// deny ACE is left; everywhere a write open succeeds again. Linux setfacl -b keeps the
// narrowed owner entry of the deny case, so the owner's write bit is given back.
export function liftAcl(file: string): void {
  assert.ok(resetAcl(file), "the ACL could be reset");
  if (process.platform === "linux") fs.chmodSync(file, fs.statSync(file).mode | 0o200);
  if (WIN) {
    const now = readAcl(file);
    if (!now) assert.fail("the ACL could not be read completely after the reset");
    assert.ok(now.endsWith("\nprotected=False") && !now.includes("(D;"), "the reset restored inheritance and left no deny ACE");
  }
  assert.equal(writeOpenError(file), "", "a write open succeeds after the reset");
}

// A directory change of the publication cases (restore-write-acl.test.mts): `inherit` and
// `inheritOther` give dir one of two different, harmless inheritable allow entries, so a
// file created in it has an ACE of its own and differs from one created in a directory
// with the other entry; `noNewNames` takes away the right to add a name to dir (the hooks
// directory), its subdirectories untouched. The cleanup is registered before the change
// and checked. null when this platform cannot run the case (never on Windows).
export function changeDirectory(t: TestContext, dir: string, change: "inherit" | "inheritOther" | "noNewNames"): true | null {
  if (!WIN && (!posixTool || process.getuid?.() === 0)) {
    t.skip("no ACL tool for this platform");
    return null;
  }
  const darwin = process.platform === "darwin";
  const undo = (): boolean => {
    if (WIN) return sh(system32("icacls.exe"), [dir, "/reset"]).status === 0;
    if (change === "noNewNames") {
      fs.chmodSync(dir, 0o755);
      return true;
    }
    return sh(posixTool, darwin ? ["-N", dir] : ["-k", dir]).status === 0;
  };
  t.after(() => assert.ok(undo(), "the directory change could be undone"));
  let done: boolean;
  const other = change === "inheritOther";
  if (WIN) {
    const ace = change === "noNewNames" ? `*${userSid()}:(WD)` : `*S-1-5-32-545:(OI)(CI)(${other ? "RA" : "R"})`;
    done = sh(system32("icacls.exe"), [dir, change === "noNewNames" ? "/deny" : "/grant", ace]).status === 0;
  } else if (change === "noNewNames") {
    fs.chmodSync(dir, 0o555);
    done = true;
  } else {
    done = sh(posixTool, darwin ? ["+a", `everyone allow ${other ? "readattr" : "readextattr"},file_inherit`, dir]
      : ["-d", "-m", `u:nobody:${other ? "x" : "r"}`, dir]).status === 0;
  }
  if (WIN) assert.ok(done, "icacls could change the directory");
  else if (!done) {
    t.skip("no ACL tool for this platform");
    return null;
  }
  return true;
}

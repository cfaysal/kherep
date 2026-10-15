import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { sha256 } from "./idle-observer-settings.mts";

const MAX_FILE_BYTES = 4 * 1024 * 1024;
type SecurityRun = (file: string, args: string[]) => string;

export function macMetadataCanCopy(listing: string, _xattrs: string, flags: string): boolean {
  const mode = listing.trimStart().split(/\s+/, 1)[0] ?? "";
  return mode.length > 0 && ["", "-", "0"].includes(flags.trim());
}

const runSecurity: SecurityRun = (command, args) => execFileSync(command, args, {
    encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, LC_ALL: "C" },
  });

function macMetadataSignature(file: string): string {
  const listing = runSecurity("ls", ["-lde", file]);
  const xattrs = runSecurity("xattr", [file]);
  const stat = runSecurity("stat", ["-f", "%u:%g:%Lp:%Sf", file]).trim();
  const match = /^(\d+):(\d+):(\d+):(.*)$/.exec(stat);
  if (!match) throw new Error("macOS metadata inspection failed");
  const [, uid, gid, modeBits, flags] = match;
  if (!macMetadataCanCopy(listing, xattrs, flags)) throw new Error("unsupported file flags");
  const lines = listing.split(/\r?\n/);
  const mode = lines[0]?.trimStart().split(/\s+/, 1)[0] ?? "";
  const hash = crypto.createHash("sha256")
    .update(`uid:${uid}\ngid:${gid}\nmode:${modeBits}:${mode}\nflags:${flags.trim()}\n`);
  for (const line of lines.slice(1).map((item) => item.trim()).filter(Boolean)) hash.update(`acl:${line}\n`);
  for (const name of xattrs.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).sort()) {
    const value = execFileSync("xattr", ["-p", name, file], {
      encoding: null, timeout: 5_000, stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C" },
    });
    hash.update(`xattr:${Buffer.byteLength(name)}:${name}:${value.length}:`).update(value);
  }
  return hash.digest("hex");
}

function copyMacMetadata(source: string, target: string): string {
  const expected = macMetadataSignature(source);
  execFileSync("cp", ["-p", source, target], { timeout: 5_000, stdio: "ignore" });
  if (macMetadataSignature(target) !== expected) throw new Error("macOS metadata copy verification failed");
  return expected;
}

function windowsSecurityMatches(file: string, privateMode: boolean): boolean {
  try {
    const script = "$p=$env:KHEREP_IDLE_PATH;"
      + "$a=if([IO.Directory]::Exists($p)){[IO.Directory]::GetAccessControl($p)}else{[IO.File]::GetAccessControl($p)};"
      + "$o=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;"
      + "$c=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;"
      + "if($o -ne $c){return};if($env:KHEREP_IDLE_PRIVATE -ne '1'){'1';return};"
      + "$r=$a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]);"
      + "$f=[Security.AccessControl.FileSystemRights]::FullControl;$ok=$r.Count -gt 0;"
      + "foreach($e in $r){if($e.IdentityReference.Value -ne $c -or $e.AccessControlType -ne 'Allow'"
      + " -or (($e.FileSystemRights -band $f) -ne $f)){$ok=$false}};if($ok){'1'}";
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", windowsHide: true, timeout: 5_000, stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, KHEREP_IDLE_PATH: file, KHEREP_IDLE_PRIVATE: privateMode ? "1" : "0" },
    }).trim() === "1";
  } catch {
    return false;
  }
}

export function ownedPath(file: string, kind: "file" | "directory", privateMode = false): boolean {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (kind === "file" ? !stat.isFile() : !stat.isDirectory())) return false;
    if (process.platform === "win32") return windowsSecurityMatches(file, privateMode);
    return typeof process.getuid === "function" && stat.uid === process.getuid()
      && (!privateMode || (stat.mode & 0o077) === 0);
  } catch {
    return false;
  }
}

function restrictWindows(file: string, directory: boolean): void {
  const sid = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], {
    encoding: "utf8", windowsHide: true, timeout: 5_000, stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!sid) throw new Error("identity unavailable");
  if (!windowsSecurityMatches(file, false)) {
    execFileSync("icacls.exe", [file, "/setowner", `*${sid}`, "/Q"], {
      windowsHide: true, timeout: 5_000, stdio: "ignore",
    });
  }
  execFileSync("icacls.exe", [file, "/inheritance:r", "/grant:r", directory ? `*${sid}:(OI)(CI)F` : `*${sid}:F`], {
    windowsHide: true, timeout: 5_000, stdio: "ignore",
  });
}

export function createPrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { mode: 0o700 });
  if (process.platform === "win32") restrictWindows(dir, true);
  else fs.chmodSync(dir, 0o700);
  if (!ownedPath(dir, "directory", true)) throw new Error("private directory not established");
}

export function readText(file: string): string {
  const stat = fs.statSync(file);
  if (stat.size > MAX_FILE_BYTES) throw new Error("file too large");
  return fs.readFileSync(file, "utf8");
}

export function writePrivateNew(file: string, text: string,
  write: (fd: number, value: string) => void = (fd, value) => fs.writeFileSync(fd, value, "utf8")): void {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    if (process.platform === "win32") restrictWindows(file, false);
    else fs.chmodSync(file, 0o600);
    if (!ownedPath(file, "file", true)) throw new Error("private file not established");
    write(fd, text);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(file, { force: true });
    throw error;
  }
  fs.closeSync(fd);
}

export interface ReplaceOwnedFileDeps {
  write?: (fd: number, text: string) => void;
}

export function windowsSecurity(file: string): string {
  const script = "$p=$env:KHEREP_IDLE_SECURITY_PATH;"
    + "$i=New-Object System.IO.FileInfo -ArgumentList $p;"
    + "$a=$i.GetAccessControl([Security.AccessControl.AccessControlSections]::Access);"
    + "$o=$i.GetAccessControl([Security.AccessControl.AccessControlSections]::Owner)"
    + ".GetOwner([Security.Principal.SecurityIdentifier]).Value;"
    + "$g=$i.GetAccessControl([Security.AccessControl.AccessControlSections]::Group)"
    + ".GetGroup([Security.Principal.SecurityIdentifier]).Value;"
    + "$d=$a.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access);"
    + "[pscustomobject]@{Owner=$o;Group=$g;Access=$d}|ConvertTo-Json -Compress";
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 5_000, stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, KHEREP_IDLE_SECURITY_PATH: file },
  }).trim();
}

function copySecurity(source: string, target: string, original: fs.Stats): string | null {
  if (process.platform === "win32") {
    const expected = windowsSecurity(source);
    const expectedParts = JSON.parse(expected) as { Owner: string; Group: string; Access: string };
    const initialParts = JSON.parse(windowsSecurity(target)) as { Owner: string; Group: string; Access: string };
    if (initialParts.Owner !== expectedParts.Owner) {
      execFileSync("icacls.exe", [target, "/setowner", `*${expectedParts.Owner}`, "/Q"], {
        windowsHide: true, timeout: 5_000, stdio: "ignore",
      });
    }
    const currentParts = JSON.parse(windowsSecurity(target)) as { Owner: string; Group: string; Access: string };
    const script = "$s=$env:KHEREP_IDLE_SECURITY_SOURCE;$t=$env:KHEREP_IDLE_SECURITY_TARGET;"
      + "$x=[Security.AccessControl.AccessControlSections]::Access;if($env:KHEREP_IDLE_COPY_GROUP -eq '1'){"
      + "$x=$x -bor [Security.AccessControl.AccessControlSections]::Group};"
      + "$si=New-Object System.IO.FileInfo -ArgumentList $s;$d=$si.GetAccessControl($x).GetSecurityDescriptorSddlForm($x);"
      + "$a=New-Object Security.AccessControl.FileSecurity;$a.SetSecurityDescriptorSddlForm($d,$x);"
      + "$ti=New-Object System.IO.FileInfo -ArgumentList $t;$ti.SetAccessControl($a)";
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, timeout: 5_000, stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, KHEREP_IDLE_SECURITY_SOURCE: source, KHEREP_IDLE_SECURITY_TARGET: target,
        KHEREP_IDLE_COPY_GROUP: currentParts.Group === expectedParts.Group ? "0" : "1" },
    });
    if (windowsSecurity(target) !== expected) throw new Error("security copy verification failed");
    return expected;
  }
  fs.chmodSync(target, original.mode & 0o7777);
  fs.chownSync(target, original.uid, original.gid);
  const copied = fs.statSync(target);
  if (copied.uid !== original.uid || copied.gid !== original.gid
    || (copied.mode & 0o7777) !== (original.mode & 0o7777)) throw new Error("security copy verification failed");
  return null;
}

function fsyncDirectory(dir: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function replaceOwnedFile(file: string, before: string, after: string,
  deps: ReplaceOwnedFileDeps = {}): void {
  if (!ownedPath(file, "file") || sha256(readText(file)) !== sha256(before)) throw new Error("concurrent drift");
  const original = fs.statSync(file);
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  let fd: number | undefined;
  const write = deps.write ?? ((target: number, text: string) => {
    const bytes = Buffer.from(text);
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(target, bytes, offset, bytes.length - offset, offset);
  });
  try {
    const macMetadata = process.platform === "darwin" ? copyMacMetadata(file, temp) : null;
    fd = fs.openSync(temp, process.platform === "darwin" ? "r+" : "wx", original.mode & 0o7777);
    let security = null;
    if (process.platform === "win32") {
      fs.closeSync(fd);
      fd = undefined;
      security = copySecurity(file, temp, original);
      fd = fs.openSync(temp, "r+");
    }
    fs.ftruncateSync(fd, 0);
    write(fd, after);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (process.platform !== "darwin" && process.platform !== "win32") {
      security = copySecurity(file, temp, original);
    }
    if (macMetadata !== null && macMetadataSignature(temp) !== macMetadata) {
      throw new Error("macOS metadata write verification failed");
    }
    const current = fs.statSync(file);
    if (current.dev !== original.dev || current.ino !== original.ino
      || sha256(readText(file)) !== sha256(before)) throw new Error("concurrent drift");
    fs.renameSync(temp, file);
    fsyncDirectory(path.dirname(file));
    if (readText(file) !== after || !ownedPath(file, "file")) throw new Error("write verification failed");
    const replaced = fs.statSync(file);
    if (process.platform === "darwin") {
      if (macMetadataSignature(file) !== macMetadata) throw new Error("macOS metadata verification failed");
    } else if (process.platform === "win32") {
      if (windowsSecurity(file) !== security) throw new Error("security verification failed");
    } else if (replaced.uid !== original.uid || replaced.gid !== original.gid
      || (replaced.mode & 0o7777) !== (original.mode & 0o7777)) throw new Error("security verification failed");
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.rmSync(temp, { force: true }); } catch { /* original target remains authoritative */ }
    throw error;
  }
}

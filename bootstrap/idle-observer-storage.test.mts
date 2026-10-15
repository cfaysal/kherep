import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { macMetadataCanCopy, ownedPath, replaceOwnedFile, restrictPrivateWindows, windowsSecurity, writePrivateNew } from "./idle-observer-storage.mts";

function ownSynthetic(...targets: string[]): void {
  if (process.platform !== "win32") return;
  for (const target of targets) {
    const kind = fs.statSync(target).isDirectory() ? "directory" : "file";
    if (!ownedPath(target, kind)) {
      const sid = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], { encoding: "utf8" }).trim();
      execFileSync("icacls.exe", [target, "/setowner", `*${sid}`, "/Q"], { stdio: "ignore", windowsHide: true });
    }
    assert.equal(ownedPath(target, kind), true);
  }
}

test("macOS metadata copying accepts ACLs and xattrs but refuses file flags", () => {
  assert.equal(macMetadataCanCopy("-rw------- 1 owner group 2 Jan 1 settings.json", "", "-"), true);
  assert.equal(macMetadataCanCopy("-rw-------+ 1 owner group 2 Jan 1 settings.json", "", "-"), true);
  assert.equal(macMetadataCanCopy("-rw------- 1 owner group 2 Jan 1 settings.json", "synthetic.attr", "-"), true);
  assert.equal(macMetadataCanCopy("-rw------- 1 owner group 2 Jan 1 settings.json", "", "uchg"), false);
});

test("Windows private creation establishes owner and DACL before content", {
  skip: process.platform !== "win32" ? "Windows owner and DACL contract" : false,
}, () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".idle-storage-test-"));
  const file = path.join(root, "private.json");
  ownSynthetic(root);
  try {
    writePrivateNew(file, "private\n", (fd, value) => {
      assert.equal(ownedPath(file, "file", true), true);
      assert.equal(fs.statSync(file).size, 0);
      fs.writeFileSync(fd, value);
    });
    assert.equal(fs.readFileSync(file, "utf8"), "private\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows security identities use canonical SIDs for owner operations", {
  skip: process.platform !== "win32" ? "Windows SID contract" : false,
}, () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".idle-storage-test-"));
  const file = path.join(root, "settings.json");
  fs.writeFileSync(file, "before\n");
  ownSynthetic(root, file);
  try {
    const identity = JSON.parse(windowsSecurity(file)) as { Owner: string; Group: string };
    assert.equal(/^S-\d(?:-\d+)+$/.test(identity.Owner), true);
    assert.equal(/^S-\d(?:-\d+)+$/.test(identity.Group), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows private restriction removes every foreign explicit ACE", {
  skip: process.platform !== "win32" ? "Windows private DACL contract" : false,
}, () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".idle-storage-test-"));
  const file = path.join(root, "private.json");
  fs.writeFileSync(file, "");
  ownSynthetic(root, file);
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$p=$env:KHEREP_TEST_PATH;$i=New-Object IO.FileInfo -ArgumentList $p;$a=$i.GetAccessControl();"
      + "$s=([Security.Principal.NTAccount]'NT AUTHORITY\\SYSTEM').Translate([Security.Principal.SecurityIdentifier]);"
      + "$r=New-Object Security.AccessControl.FileSystemAccessRule($s,'Read','Allow');$a.AddAccessRule($r);$i.SetAccessControl($a)"],
    { env: { ...process.env, KHEREP_TEST_PATH: file }, stdio: "ignore" });
    assert.equal(ownedPath(file, "file", true), false);
    restrictPrivateWindows(file, false);
    assert.equal(ownedPath(file, "file", true), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Windows replacement preserves an already matching inherited DACL", {
  skip: process.platform !== "win32" ? "Windows inherited DACL contract" : false,
}, () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".idle-storage-test-"));
  ownSynthetic(root);
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$p=$env:KHEREP_TEST_PATH;$i=New-Object IO.DirectoryInfo -ArgumentList $p;$a=New-Object Security.AccessControl.DirectorySecurity;"
    + "$a.SetAccessRuleProtection($true,$false);$c=[Security.Principal.WindowsIdentity]::GetCurrent().User;"
    + "$s=([Security.Principal.NTAccount]'NT AUTHORITY\\SYSTEM').Translate([Security.Principal.SecurityIdentifier]);"
    + "$f=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit';$n=[Security.AccessControl.PropagationFlags]::None;"
    + "$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($c,'FullControl',$f,$n,'Allow')));"
    + "$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($s,'ReadAndExecute',$f,$n,'Allow')));$i.SetAccessControl($a)"],
  { env: { ...process.env, KHEREP_TEST_PATH: root }, stdio: "ignore" });
  const file = path.join(root, "settings.json");
  fs.writeFileSync(file, "before\n");
  ownSynthetic(file);
  try {
    replaceOwnedFile(file, "before\n", "after\n");
    assert.equal(fs.readFileSync(file, "utf8"), "after\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("settings replacement restores the original bytes after a write failure", () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".idle-storage-test-"));
  const file = path.join(root, "settings.json");
  const before = "{\"synthetic\":true}\n";
  fs.writeFileSync(file, before, { mode: 0o600 });
  ownSynthetic(root, file);
  let writes = 0;
  try {
    assert.throws(() => replaceOwnedFile(file, before, "replacement\n", {
      write(fd, text) {
        writes++;
        if (writes === 1) {
          fs.writeSync(fd, "partial", 0, "utf8");
          throw new Error("synthetic write failure");
        }
        fs.writeSync(fd, text, 0, "utf8");
      },
    }), /synthetic write failure/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.deepEqual(fs.readdirSync(root), ["settings.json"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("atomic replacement preserves the target security mode", () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".idle-storage-test-"));
  const file = path.join(root, "settings.json");
  fs.writeFileSync(file, "before\n", { mode: 0o640 });
  ownSynthetic(root, file);
  const mode = fs.statSync(file).mode & 0o7777;
  try {
    replaceOwnedFile(file, "before\n", "after\n");
    assert.equal(fs.readFileSync(file, "utf8"), "after\n");
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o7777, mode);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows replacement applies the target owner, group and DACL before writing content", {
  skip: process.platform !== "win32" ? "Windows DACL contract" : false,
}, () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".idle-storage-test-"));
  const file = path.join(root, "settings.json");
  fs.writeFileSync(file, "before\n");
  ownSynthetic(root, file);
  const sid = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], { encoding: "utf8" }).trim();
  execFileSync("icacls.exe", [file, "/inheritance:r", "/grant:r", `*${sid}:F`], { stdio: "ignore" });
  const security = (target: string): string => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$i=New-Object IO.FileInfo -ArgumentList $env:KHEREP_TEST_PATH;"
    + "$x=[Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group"
    + " -bor [Security.AccessControl.AccessControlSections]::Access;"
    + "$i.GetAccessControl($x).GetSecurityDescriptorSddlForm($x)"], {
    encoding: "utf8", env: { ...process.env, KHEREP_TEST_PATH: target },
  }).trim();
  const expected = security(file);
  try {
    replaceOwnedFile(file, "before\n", "after\n", { write(fd, text) {
      const temp = fs.readdirSync(root).map((name) => path.join(root, name)).find((item) => item !== file);
      assert.ok(temp);
      assert.equal(security(temp) === expected, true, "temporary security differs before content write");
      fs.writeFileSync(fd, text);
    } });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

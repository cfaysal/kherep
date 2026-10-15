import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { macMetadataCanCopy, replaceOwnedFile } from "./idle-observer-storage.mts";

test("macOS metadata copying accepts ACLs and xattrs but refuses file flags", () => {
  assert.equal(macMetadataCanCopy("-rw------- 1 owner group 2 Jan 1 settings.json", "", "-"), true);
  assert.equal(macMetadataCanCopy("-rw-------+ 1 owner group 2 Jan 1 settings.json", "", "-"), true);
  assert.equal(macMetadataCanCopy("-rw------- 1 owner group 2 Jan 1 settings.json", "synthetic.attr", "-"), true);
  assert.equal(macMetadataCanCopy("-rw------- 1 owner group 2 Jan 1 settings.json", "", "uchg"), false);
});

test("settings replacement restores the original bytes after a write failure", () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".idle-storage-test-"));
  const file = path.join(root, "settings.json");
  const before = "{\"synthetic\":true}\n";
  fs.writeFileSync(file, before, { mode: 0o600 });
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
  const mode = fs.statSync(file).mode & 0o7777;
  try {
    replaceOwnedFile(file, "before\n", "after\n");
    assert.equal(fs.readFileSync(file, "utf8"), "after\n");
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o7777, mode);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows replacement applies the target DACL before writing content", {
  skip: process.platform !== "win32" ? "Windows DACL contract" : false,
}, () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".idle-storage-test-"));
  const file = path.join(root, "settings.json");
  fs.writeFileSync(file, "before\n");
  const sid = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], { encoding: "utf8" }).trim();
  execFileSync("icacls.exe", [file, "/inheritance:r", "/grant:r", `*${sid}:F`], { stdio: "ignore" });
  const access = (target: string): string => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$i=New-Object IO.FileInfo -ArgumentList $env:KHEREP_TEST_PATH;"
    + "$x=[Security.AccessControl.AccessControlSections]::Access;"
    + "$i.GetAccessControl($x).GetSecurityDescriptorSddlForm($x)"], {
    encoding: "utf8", env: { ...process.env, KHEREP_TEST_PATH: target },
  }).trim();
  const expected = access(file);
  try {
    replaceOwnedFile(file, "before\n", "after\n", { write(fd, text) {
      const temp = fs.readdirSync(root).map((name) => path.join(root, name)).find((item) => item !== file);
      assert.ok(temp);
      assert.ok(access(temp) === expected, "temporary DACL differs from the target before content write");
      fs.writeFileSync(fd, text);
    } });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

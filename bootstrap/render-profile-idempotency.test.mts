import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { renderSettings } from "./render-profile.mts";

test("OP-1157 rendering full managed settings from their own output is idempotent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "op1157-settings-idempotence-"));
  const sourceUser = path.join(import.meta.dirname, "..", "claude", "settings.user.json");
  const sourceProject = path.join(dir, "project.src.json");
  fs.writeFileSync(sourceProject, "{}");

  try {
    for (const profile of ["win", "mac"]) {
      const firstUser = path.join(dir, `${profile}.user.first.json`);
      const firstProject = path.join(dir, `${profile}.project.first.json`);
      const secondUser = path.join(dir, `${profile}.user.second.json`);
      const secondProject = path.join(dir, `${profile}.project.second.json`);
      renderSettings([profile, "/example/Kherep", "/example/credentials", "/example/.claude",
        sourceUser, sourceProject, "-", "-", firstUser, firstProject]);
      renderSettings([profile, "/example/Kherep", "/example/credentials", "/example/.claude",
        sourceUser, sourceProject, firstUser, firstProject, secondUser, secondProject]);

      assert.equal(fs.readFileSync(secondUser, "utf8"), fs.readFileSync(firstUser, "utf8"), `${profile} user settings`);
      assert.equal(fs.readFileSync(secondProject, "utf8"), fs.readFileSync(firstProject, "utf8"), `${profile} project settings`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

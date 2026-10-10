import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { defaultTokenFile, resolveTokenBinding, tokenBindingProblem } from "./atlassian-mcp-binding.mts";

const TEMP = process.platform === "win32" ? os.tmpdir() : fs.realpathSync(os.tmpdir());

function homes(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(TEMP, "atl-mcp-binding-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const value = { claude: path.join(root, ".claude"), codex: path.join(root, ".codex") };
  for (const home of Object.values(value)) fs.mkdirSync(path.join(home, "kherep"), { recursive: true });
  return { root, homes: value };
}

function key(file: string, mode = 0o600): string {
  fs.writeFileSync(file, `${"z".repeat(48)}\n`, { mode });
  return file;
}

test("each runtime defaults to its own key file under its own home", (t) => {
  const { homes: h } = homes(t);
  const claude = resolveTokenBinding("claude", h, {});
  assert.deepEqual(claude, { runtime: "claude", file: defaultTokenFile("claude", h.claude), source: "default", status: "missing" });
  key(claude.file);
  assert.equal(resolveTokenBinding("claude", h, {}).status, "ok");
  assert.equal(resolveTokenBinding("codex", h, {}).status, "missing", "the Claude file is no Codex file");
});

test("the runtime's own variable wins over the default, and an option over both", (t) => {
  const { root, homes: h } = homes(t);
  const fromEnv = key(path.join(root, "env.txt"));
  const fromOption = key(path.join(root, "option.txt"));
  assert.deepEqual(resolveTokenBinding("codex", h, { KHEREP_ATL_MCP_TOKEN_FILE_CODEX: fromEnv }),
    { runtime: "codex", file: fromEnv, source: "env", status: "ok" });
  assert.equal(resolveTokenBinding("codex", h, { KHEREP_ATL_MCP_TOKEN_FILE_CODEX: fromEnv }, fromOption).file, fromOption);
  assert.equal(resolveTokenBinding("codex", h, { KHEREP_ATL_MCP_TOKEN_FILE_CLAUDE: fromEnv }).source, "default");
});

test("a file of the other runtime or of a broker credential is refused", (t) => {
  const { root, homes: h } = homes(t);
  const shared = key(path.join(root, "shared.txt"));
  for (const env of [
    { KHEREP_ATL_MCP_TOKEN_FILE_CLAUDE: shared },
    { KHEREP_ATL_CRED_FILE_CODEX: shared },
    { KHEREP_ATL_CRED_FILE_CLAUDE: shared },
  ]) {
    const binding = resolveTokenBinding("codex", h, { ...env, KHEREP_ATL_MCP_TOKEN_FILE_CODEX: shared });
    assert.equal(binding.status, "shared", JSON.stringify(env));
    assert.match(String(tokenBindingProblem(binding)), /KHEREP_ATL_MCP_TOKEN_FILE_CODEX/);
  }
  // The broker's default credential file counts as well.
  const broker = key(path.join(h.claude, "kherep", "atl-credential-claude.txt"));
  assert.equal(resolveTokenBinding("claude", h, { KHEREP_ATL_MCP_TOKEN_FILE_CLAUDE: broker }).status, "shared");
  if (process.platform !== "win32") {
    const link = path.join(root, "link.txt");
    fs.symlinkSync(shared, link);
    assert.equal(resolveTokenBinding("codex", h,
      { KHEREP_ATL_MCP_TOKEN_FILE_CODEX: link, KHEREP_ATL_MCP_TOKEN_FILE_CLAUDE: shared }).status, "shared");
  }
});

test("reports a loose or relative file as invalid and names no key", (t) => {
  const { root, homes: h } = homes(t);
  assert.equal(resolveTokenBinding("codex", h, { KHEREP_ATL_MCP_TOKEN_FILE_CODEX: "relative.txt" }).status, "invalid");
  if (process.platform !== "win32") {
    const loose = key(path.join(root, "loose.txt"), 0o644);
    fs.chmodSync(loose, 0o644);
    const binding = resolveTokenBinding("codex", h, { KHEREP_ATL_MCP_TOKEN_FILE_CODEX: loose });
    assert.equal(binding.status, "invalid");
    assert.doesNotMatch(String(tokenBindingProblem(binding)), /z{8}/);
  }
  assert.equal(tokenBindingProblem({ runtime: "codex", file: "/x", source: "default", status: "ok" }), undefined);
});

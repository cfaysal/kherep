import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { run, type Runtime } from "./runner.mts";

for (const backend of ["win", "mac"]) {
  for (const mode of ["lookup", "reasoning"]) {
    test(`${backend} ${mode} sends its token budget, timeout and thinking settings`, async (t) => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "local-inference-limits-")));
      t.after(() => {
        assert.ok(root.startsWith(`${fs.realpathSync(os.tmpdir())}${path.sep}`));
        fs.rmSync(root, { recursive: true, force: true });
      });
      const requests: unknown[] = [];
      const runtime: Runtime = {
        env: {
          KHEREP_PROFILE: "win",
          KHEREP_WORKSPACE: root,
          KHEREP_CREDENTIALS_ROOT: path.join(root, "credentials"),
          KHEREP_LOCAL_OUTPUT_ROOT: path.join(root, "output"),
        },
        config: {
          schemaVersion: 2,
          backends: {
            [backend]: { engine: "synthetic", endpoint: "http://127.0.0.1:1234/v1", model: "discover" },
          },
          profiles: { win: { backends: { [backend]: { transport: "local" } } } },
        },
        requestJson: async (url, method, body, timeoutMs) => {
          if (url.endsWith("/models")) return { data: [{ id: "synthetic-model" }] };
          requests.push({ url, method, body, timeoutMs });
          return { choices: [{ message: { content: "Synthetic result" } }] };
        },
      };

      await run(["--backend", backend, "--mode", mode, "--task", "Return a synthetic result"], runtime);

      assert.deepEqual(requests, [{
        url: "http://127.0.0.1:1234/v1/chat/completions",
        method: "POST",
        body: {
          model: "synthetic-model",
          messages: [
            { role: "system", content: "You are a concise local research worker. Return evidence-backed findings." },
            { role: "user", content: "Return a synthetic result" },
          ],
          temperature: 0.2,
          max_tokens: mode === "reasoning" ? 8192 : 700,
          ...(backend === "win" && mode === "lookup" ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        },
        timeoutMs: mode === "reasoning" ? 300_000 : 120_000,
      }]);
    });
  }
}

import assert from "node:assert/strict";
import test from "node:test";
import { setPluginEnabled } from "./plugin-config.mts";

test("updates only the owned plugin enabled line and preserves unrelated settings", () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = ['model = "keep"', '[plugins."fixture@local"]', 'custom = "keep"', '  enabled = false # previous', '[other]', 'enabled = false', ''].join(newline);
    assert.equal(setPluginEnabled(source, "fixture@local", true), source.replace('  enabled = false # previous', 'enabled = true'));
  }
});

test("rejects duplicate tables and duplicate enabled settings before producing configuration", () => {
  assert.throws(() => setPluginEnabled('[plugins."fixture@local"]\nenabled = true\n[plugins."fixture@local"]\n', "fixture@local", true), /duplicate TOML table/);
  assert.throws(() => setPluginEnabled('[plugins."fixture@local"]\nenabled = true\nenabled = false\n', "fixture@local", true), /duplicate enabled settings/);
});

test("creates or populates exactly the selected plugin table", () => {
  assert.equal(setPluginEnabled('model = "keep"\n', "fixture@local", false), 'model = "keep"\n\n[plugins."fixture@local"]\nenabled = false\n');
  assert.equal(setPluginEnabled('[plugins."fixture@local"]\ncustom = true\n', "fixture@local", true), '[plugins."fixture@local"]\nenabled = true\ncustom = true\n');
});

import assert from "node:assert/strict";
import test from "node:test";

import { render, type RenderOptions } from "./parity-config.mts";

const MATCHER = "^mcp__kherep_messaging__(sessions|send|inbox|reply|status)$";

function options(enabled: boolean): RenderOptions {
  return {
    contextHook: "/codex/hooks/context.mts", hookDir: "/codex/hooks/kherep", mcpServers: [],
    node: "/usr/bin/node", messagingClient: { enabled,
      bridge: "/codex/orchestra/control-plane/node/mcp-stdio-bridge.mts",
      intentHook: "/codex/orchestra/control-plane/node/mcp-intent-hook.mts",
      configRoot: "/operator/config" },
  };
}

test("renders the messaging client table and exact intent hook only when opted in", () => {
  const disabled = render(options(false));
  assert.doesNotMatch(disabled, /kherep_messaging|mcp-intent-hook|mcp-stdio-bridge/);

  const enabled = render(options(true));
  assert.equal(enabled.match(/\[mcp_servers\.kherep_messaging\]/g)?.length, 1);
  assert.match(enabled, new RegExp(`matcher = ${JSON.stringify(MATCHER).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(enabled, /command = "\\\"\/usr\/bin\/node\\\" \\\"\/codex\/orchestra\/control-plane\/node\/mcp-intent-hook\.mts\\\" \\\"--config-root\\\" \\\"\/operator\/config\\\""/);
  assert.match(enabled, /command = "\/usr\/bin\/node"/);
  assert.match(enabled, /args = \["\/codex\/orchestra\/control-plane\/node\/mcp-stdio-bridge\.mts", "--config-root", "\/operator\/config"\]/);
  assert.doesNotMatch(enabled, /approval_mode|permissionDecision|Authorization|Bearer|token/i);
});

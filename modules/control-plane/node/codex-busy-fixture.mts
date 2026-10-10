import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type test from "node:test";

import { listenerDir } from "./autonomy.mts";
import { busyPolicyFingerprint } from "./codex-busy-publish.mts";
import { publishBusyHint } from "./codex-busy-ticket.mts";
import { recordCodexSession } from "./codex-sessions.mts";
import { storeMessage } from "./inbox.mts";
import { loadPolicy } from "./policy.mts";
import { T0, taskNode } from "./task-fixture.mts";

export const BUSY_OWNER = "01a0db74-0000-7000-8000-000000000001";
export const BUSY_BODY = "synthetic peer body must not appear in a busy hint";
export const BUSY_CONTEXT = "Kherep: New peer messages are waiting. Check this session's inbox and report any relevant update.";

export function busyFixture(t: test.TestContext, count = 1, now = T0) {
  const node = taskNode(t, { runtimes: ["codex"] }, { wake: { enabled: true, sessions: [BUSY_OWNER] } });
  recordCodexSession(node.paths, BUSY_OWNER, node.workspace, now, "default");
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  for (const messageId of ids) storeMessage(node.paths.inbox, { messageId,
    from: { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "synthetic-peer" },
    toSession: BUSY_OWNER, text: BUSY_BODY, createdAt: new Date(now).toISOString() }, now);
  const ticket = path.join(listenerDir(node.paths), `${BUSY_OWNER}.busy-hint.json`);
  const admission = { owner: BUSY_OWNER, generation: crypto.randomUUID(), admittedAt: now, expiresAt: now + 60_000,
    policyFingerprint: busyPolicyFingerprint(loadPolicy(node.paths.policy)),
    messages: ids.slice(0, 8).map((messageId) => ({ messageId, toSession: BUSY_OWNER })) };
  assert.equal(publishBusyHint(listenerDir(node.paths), admission, now), "published");
  const input = { hook_event_name: "PostToolUse", session_id: BUSY_OWNER, permission_mode: "default",
    transcript_path: `C:/synthetic/sessions/rollout-2026-10-10T10-00-00-${BUSY_OWNER}.jsonl`,
    tool_name: "Bash", cwd: node.workspace };
  return { ...node, ids, ticket, admission, input, hookDeps: { paths: node.paths, now: () => now },
    inboxBytes: () => ids.map((id) => fs.readFileSync(path.join(node.paths.inbox, `${id}.json`), "utf8")) };
}

// Synthetic two-process storage fixture, never part of an installed Hook.
import crypto from "node:crypto";

import { claimProxied } from "./inbox-proxied.mts";

const [dir, messageId] = process.argv.slice(2);
process.once("message", () => {
  let result: string;
  const relayMessageId = crypto.randomUUID();
  try {
    const claim = claimProxied(dir, messageId, { relayMessageId, forkId: "fork-a", attemptId: crypto.randomUUID(), at: new Date(0).toISOString() });
    result = claim.created ? `created ${relayMessageId}` : `existing ${claim.record.relayMessageId}`;
  } catch (error) {
    result = `error: ${(error as Error).message}`;
  }
  process.send?.({ type: "result", result }, () => process.disconnect());
});
process.send?.({ type: "ready" });

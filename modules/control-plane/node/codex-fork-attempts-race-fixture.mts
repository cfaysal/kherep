// Synthetic two-process storage fixture, never part of an installed Hook.
import { claimForkAttempt } from "./codex-fork-attempts.mts";
import { nodePaths } from "./config.mts";

const [root, owner, messageId, time] = process.argv.slice(2);
process.once("message", () => {
  let result: string | null;
  try {
    result = claimForkAttempt(nodePaths(root), { owner, messageId, attemptedAt: Number(time), policyFingerprint: "a".repeat(64),
      producer: { route: "local" } })?.attemptId ?? null;
  } catch (error) {
    result = `error: ${(error as Error).message}`;
  }
  process.send?.({ type: "result", result }, () => process.disconnect());
});
process.send?.({ type: "ready" });

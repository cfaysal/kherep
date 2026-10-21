import type { NodePaths } from "./config.mts";
import { purgeInbox } from "./inbox-purge.mts";
import { settleAnsweredAtStart } from "./sent-notices.mts";

// What startDaemon does to inbox/ and sent/ before the client connects (issue
// #520): settle answered sent records first, then purge the inbox. The order is
// the point: the purge removes the replies that are the only evidence a
// delivered record was answered. Each step is fail-soft and logged.
export function startInboxMaintenance(paths: NodePaths, log: (line: string) => void, now: number = Date.now()): void {
  try {
    const settled = settleAnsweredAtStart(paths, now, (error) => log(`kherep-node: could not record a sent message replied: ${String(error)}`));
    if (settled > 0) log(`kherep-node: recorded ${settled} sent message(s) replied before the inbox purge`);
  } catch (error) {
    log(`kherep-node: sent settle at start failed: ${String(error)}`);
  }
  try {
    const purged = purgeInbox(paths.inbox, now);
    if (purged > 0) log(`kherep-node: removed ${purged} inbox message(s) older than 7 days`);
  } catch (error) {
    log(`kherep-node: inbox purge failed: ${String(error)}`);
  }
}

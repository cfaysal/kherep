import type { NodeClient } from "./client.mts";
import type { SessionInfo } from "../protocol.mts";
import type { NodePaths } from "./config.mts";
import { recordingSessions } from "./exchange.mts";
import { publishSessionFrames } from "./session-publication.mts";

export async function recordAndPublishSessions(client: NodeClient, paths: NodePaths, sessions: SessionInfo[],
  send: (frame: string) => boolean, log: (line: string) => void, signal: AbortSignal): Promise<void> {
  const recorded = await recordingSessions(paths, async () => sessions, log)(signal);
  publishSessionFrames(client, client.sessionFrames(recorded), send);
}

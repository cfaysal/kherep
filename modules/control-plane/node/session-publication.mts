import type { NodeClient } from "./client.mts";
import type { SessionInfo } from "../protocol.mts";
import type { NodePaths } from "./config.mts";
import { recordingSessions } from "./exchange.mts";

// A cached snapshot must never stand in for a frame that failed to leave.
export function publishSessionFrames(client: NodeClient, frames: string[], send: (frame: string) => boolean): boolean {
  let published = false;
  try { published = frames.every(send); return published; }
  finally { if (!published) client.invalidateSessionsSnapshot(); }
}

export async function recordAndPublishSessions(client: NodeClient, paths: NodePaths, sessions: SessionInfo[],
  send: (frame: string) => boolean, log: (line: string) => void, signal: AbortSignal): Promise<void> {
  const recorded = await recordingSessions(paths, async () => sessions, log)(signal);
  publishSessionFrames(client, client.sessionFrames(recorded), send);
}

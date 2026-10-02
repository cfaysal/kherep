import type { NodeClient } from "./client.mts";

// A cached snapshot must never stand in for a frame that failed to leave.
export function publishSessionFrames(client: NodeClient, frames: string[], send: (frame: string) => boolean): boolean {
  let published = false;
  try { published = frames.every(send); return published; }
  finally { if (!published) client.invalidateSessionsSnapshot(); }
}

import { MAX_FRAME_BYTES } from "../../protocol.mts";
import {
  MAX_DIRECTORY_NODES, MAX_DIRECTORY_SESSIONS, type DirectoryBody, type DirectorySession,
} from "../../protocol-messages.mts";

// Leaves room for the envelope around the body.
const MAX_BODY_BYTES = MAX_FRAME_BYTES - 1024;

// Builds the directory body from Registry rows. Sessions of revoked nodes are
// left out even though revocation already deletes them. A body that would not
// fit into one frame drops sessions from the end and says so in truncated.
export function directoryBody(nodeRows: Record<string, SqlStorageValue>[],
  sessions: (DirectorySession & { startedAt?: string; updatedAt?: number })[], now: number): DirectoryBody {
  const nodes = nodeRows.slice(0, MAX_DIRECTORY_NODES)
    .map((r) => ({ nodeId: String(r.id), name: String(r.name), status: String(r.status) }));
  const listed = new Set(nodes.map((n) => n.nodeId));
  const kept = sessions.filter((s) => listed.has(s.nodeId)).map(({ startedAt: _s, updatedAt: _u, ...session }) => session);
  const body: DirectoryBody = { nodes, sessions: kept.slice(0, MAX_DIRECTORY_SESSIONS), fetchedAt: new Date(now).toISOString() };
  if (body.sessions.length < kept.length || nodes.length < nodeRows.length) body.truncated = true;
  const encoder = new TextEncoder();
  while (body.sessions.length > 0 && encoder.encode(JSON.stringify(body)).length > MAX_BODY_BYTES) {
    body.sessions.length = Math.floor(body.sessions.length * 0.9);
    body.truncated = true;
  }
  return body;
}

import type { SessionInfo } from "../protocol.mts";

// Leave room for the exchange tick and acknowledgement inside the unchanged
// eight-second native hook deadline. Periodic discovery keeps its own budget.
const MCP_SESSION_DISCOVERY_MS = 2_000;

export async function discoverMcpSessions(list: (signal?: AbortSignal) => Promise<SessionInfo[]>, remainingMs = MCP_SESSION_DISCOVERY_MS): Promise<SessionInfo[]> {
  if (remainingMs <= 0) throw new Error("MCP_SESSION_DISCOVERY_TIMEOUT");
  const controller = new AbortController();
  let timer!: NodeJS.Timeout;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("MCP_SESSION_DISCOVERY_TIMEOUT"));
    }, Math.min(remainingMs, MCP_SESSION_DISCOVERY_MS));
  });
  try { return await Promise.race([list(controller.signal), expired]); }
  finally { clearTimeout(timer); }
}

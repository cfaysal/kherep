// Exponential backoff with "equal jitter" (half fixed, half random), so a fleet
// of nodes does not retry in lockstep (issue #5, design section 3): attempt n
// waits between half and all of min(maxMs, baseMs * 2^n).
export interface Backoff { baseMs: number; maxMs: number }

export function retryDelay(attempt: number, { baseMs, maxMs }: Backoff, random: () => number = Math.random): number {
  const exponent = Math.min(Math.max(0, Math.floor(attempt)), 16);
  const ceiling = Math.min(maxMs, baseMs * 2 ** exponent);
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(ceiling / 2 + r * (ceiling / 2));
}

// Reconnect delay: from 1 s, capped at 60 s.
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;

export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  return retryDelay(attempt, { baseMs: BACKOFF_BASE_MS, maxMs: BACKOFF_MAX_MS }, random);
}

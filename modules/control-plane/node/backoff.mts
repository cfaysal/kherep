// Reconnect delay: exponential from 1 s, capped at 60 s, with "equal jitter"
// (half fixed, half random) so a fleet of nodes does not reconnect in lockstep
// after a control-plane restart (issue #5, design section 3).
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;

export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.min(Math.max(0, Math.floor(attempt)), 16);
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** exponent);
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(ceiling / 2 + r * (ceiling / 2));
}

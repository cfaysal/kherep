// Shared pointer text without importing the native process launcher.
export function nativeQueueText(count: number): string {
  return `Kherep: ${count} peer message(s) waiting in your inbox.`;
}

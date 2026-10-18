// Test fixture, issue #503. On the Node floor versions (22.18, 24.1) every Node
// process that loads a .mts file prints the type-stripping ExperimentalWarning to
// stderr once; later Node versions print nothing. Tests that compare stderr remove
// at most `max` such warning blocks, so a process that warns more often than its
// direct counterpart still fails the comparison. Nothing else is removed.
const WARNING = /^\(node:\d+\) ExperimentalWarning: [^\n]*\n(?:\(Use `node --trace-warnings [^\n]*\n)?/m;

export function withoutNodeWarnings(stderr: string, max = Number.POSITIVE_INFINITY): string {
  let text = stderr;
  for (let removed = 0; removed < max && WARNING.test(text); removed += 1) text = text.replace(WARNING, "");
  return text;
}

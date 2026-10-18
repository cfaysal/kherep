// Test fixture, issue #503. On the Node floor versions (22.18, 24.1) every Node
// process that loads a .mts file prints the type-stripping ExperimentalWarning to
// stderr once; later Node versions print nothing. Tests that compare stderr remove
// at most `max` of exactly that block, so a process that warns more often than its
// direct counterpart still fails the comparison. Any other warning, of any
// category, is kept.
const WARNING = /^\(node:\d+\) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time\n(?:\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n)?/m;

export function withoutTypeStrippingWarning(stderr: string, max: number): string {
  let text = stderr;
  for (let removed = 0; removed < max && WARNING.test(text); removed += 1) text = text.replace(WARNING, "");
  return text;
}

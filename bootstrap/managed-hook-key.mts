// Issue #568. The key of a managed hook that runs through the hook runtime,
//   node "<home>/kherep/hook-runtime/entry.<ext>" <pretool|reader|writer> "<home>/hooks/<main>" ...
// with the same <home> on both sides (the coordinated shape of
// claude/hooks/lib/hook-inventory.mts). A leaf module: it takes the command as
// normalizeHookCommand() left it, so `\`, `$HOME`, `${HOME}`, `%USERPROFILE%`
// and the user home are already folded. Mode and later arguments are not part
// of the key. Not recognised, and so kept as operator hooks: `& node`,
// `node <flags>`, single quotes, mixed quoting, the Git Bash `/c/...` form of
// a drive path and `.`/`..` segments in the main path.

const ENTRY = String.raw`\/kherep\/hook-runtime\/entry\.(?:js|mjs|cjs|mts)`;
const MODE = String.raw`\s+(?:pretool|reader|writer)\s+`;
// Two whole alternatives, quoted and bare, each with its own back-reference: a
// back-reference to a group that did not take part matches the empty string.
const MANAGED_ENTRY = new RegExp(
  `^node\\s+(?:"(?<qh>[^"]+?)${ENTRY}"${MODE}"\\k<qh>\\/hooks\\/(?<qm>[^"]+)"`
  + `|(?<uh>\\S+?)${ENTRY}${MODE}\\k<uh>\\/hooks\\/(?<um>[^"\\s]+))(?=$|\\s)`,
);

export interface ManagedHookKey {
  // <home>/hooks/<main> without the script extension; lower-cased first on win32.
  key: string;
  // The main as written after <home>/hooks/, extension included.
  main: string;
}

export function managedHookKey(command: string, platform: string = process.platform): ManagedHookKey | undefined {
  const groups = MANAGED_ENTRY.exec(command)?.groups;
  if (!groups) return undefined;
  const home = groups.qh ?? groups.uh!;
  const main = groups.qm ?? groups.um!;
  const path = `${home}/hooks/${main}`;
  return { key: (platform === "win32" ? path.toLowerCase() : path).replace(/\.(?:js|mjs|cjs|mts)$/, ""), main };
}

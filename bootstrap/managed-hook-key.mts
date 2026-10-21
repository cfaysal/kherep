// Issue #568. The key of a managed hook that runs through the hook runtime,
//   node "<home>/kherep/hook-runtime/entry.<ext>" <pretool|reader|writer> "<home>/hooks/<main>" ...
// with the same <home> on both sides (the coordinated shape of
// claude/hooks/lib/hook-inventory.mts). A leaf module: it takes the command as
// normalizeHookCommand() left it, so `\`, `$HOME`, `${HOME}`, `%USERPROFILE%`
// and the user home are already folded. Mode and later arguments are not part
// of the key. Not recognised, and so kept as operator hooks: `& node`,
// `node <flags>`, single quotes, mixed quoting, the Git Bash `/c/...` form of
// a drive path, `.`/`..` segments in the main path, a line break between the
// parts, and a shell control operator, substitution or redirection after the
// main outside double quotes.

const ENTRY = String.raw`\/kherep\/hook-runtime\/entry\.(?:js|mjs|cjs|mts)`;
const MODE = String.raw`[ \t]+(?:pretool|reader|writer)[ \t]+`;
// Two whole alternatives, quoted and bare, each with its own back-reference: a
// back-reference to a group that did not take part matches the empty string.
const MANAGED_ENTRY = new RegExp(
  `^node[ \\t]+(?:"(?<qh>[^"]+?)${ENTRY}"${MODE}"\\k<qh>\\/hooks\\/(?<qm>[^"]+)"`
  + `|(?<uh>\\S+?)${ENTRY}${MODE}\\k<uh>\\/hooks\\/(?<um>[^"\\s]+))(?=$|\\s)`,
);

export interface ManagedHookKey {
  // <home>/hooks/<main> without the script extension; lower-cased first on win32.
  key: string;
  // The main as written after <home>/hooks/, extension included.
  main: string;
}

// A shell control operator, command substitution or redirection after the main
// runs more than the hook: the command is operator-shaped and kept, never
// replaced. Double-quoted text is a path (a home such as R&D) and is skipped.
const CONTROL_OPERATOR = /[;&|<>\r\n`]|\$\(/;
const outsideQuotes = (text: string): string => text.replace(/"[^"]*"/g, "");

export function managedHookKey(command: string, platform: string = process.platform): ManagedHookKey | undefined {
  const match = MANAGED_ENTRY.exec(command);
  const groups = match?.groups;
  if (!groups || CONTROL_OPERATOR.test(outsideQuotes(command.slice(match[0].length)))) return undefined;
  const home = groups.qh ?? groups.uh!;
  const main = groups.qm ?? groups.um!;
  const path = `${home}/hooks/${main}`;
  return { key: (platform === "win32" ? path.toLowerCase() : path).replace(/\.(?:js|mjs|cjs|mts)$/, ""), main };
}

// Issues #31 and #590. The key of a control-plane hook, `node "<root>/modules/
// control-plane/node/<script>" ...`: the script's path from `modules/control-plane/
// node/` on, without the extension and lower-cased on win32, so the same script
// has one key whatever root it runs from (the checkout, a worktree, a service
// source pin, with `/` or `\`). An installer that keyed on the full path never
// replaced the entries of an install from another root; a node measured 16
// control-plane entries instead of 8 after `service upgrade` and an install from
// the pin. Arguments are not part of the key (#31: the wake timeout). Only the
// bare `node <script>` form is recognised, and, as for managedHookKey(), a
// command with a shell control operator, substitution or redirection outside
// double quotes is operator-shaped; any other hook is undefined. On win32 the
// script is lower-cased before the segment is searched, so `\Modules\...` counts.
// Issue #592. The stable form, `node "<home>/kherep/control-plane/
// claude-control-plane-hook.mts" <deliver|wake|attribution> ...`, has the key of
// the script the name selects, so the merge replaces a path-form entry of an
// older install with the stable one and a duplicate scan counts both forms as
// one script. The name is the first argument; here alone an argument is part of
// the key. The entry may sit under any home (root neutrality, #595): the suffix
// decides, not the home. Any other name is not a control-plane hook; a hand-quoted
// name ("deliver") is not keyed either, although the shell would unquote it.
const CONTROL_PLANE_SCRIPT = /^node\s+(?:"([^"]+)"|(\S+))(?:\s+(\S+))?/;
const CONTROL_PLANE_DIR = "/modules/control-plane/node/";
const STABLE_ENTRY = "/kherep/control-plane/claude-control-plane-hook";
const STABLE_NAMES: Readonly<Record<string, string>> = Object.freeze({ deliver: "deliver-hook", wake: "wake-hook", attribution: "attribution-hook" });

export function controlPlaneHookKey(command: string, platform: string = process.platform): string | undefined {
  const match = CONTROL_PLANE_SCRIPT.exec(command);
  if (!match || CONTROL_OPERATOR.test(outsideQuotes(command))) return undefined;
  const written = (match[1] ?? match[2]).replace(/\\/g, "/");
  const script = (platform === "win32" ? written.toLowerCase() : written).replace(/\.(?:js|mjs|cjs|mts)$/, "");
  if (script.endsWith(STABLE_ENTRY)) {
    const name = match[3] === undefined ? undefined : STABLE_NAMES[match[3]];
    return name === undefined ? undefined : `${CONTROL_PLANE_DIR.slice(1)}${name}`;
  }
  const at = script.lastIndexOf(CONTROL_PLANE_DIR);
  if (at < 0) return undefined;
  const key = script.slice(at + 1);
  return key === CONTROL_PLANE_DIR.slice(1) ? undefined : key;
}

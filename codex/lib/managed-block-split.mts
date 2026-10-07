// Issue #274. The Codex app, storing hook trust, can rewrite config.toml so that
// its `[hooks.state]` tables sit inside the managed block while the rest of the
// managed fragment sits behind the end marker, and the end marker can separate
// the keys of one trust table. The TOML is unchanged, the text matches no fragment.

const MESSAGE = "Refusing to overwrite a managed block without an exact known managed fragment";

export class UnknownManagedFragmentError extends Error {
  readonly knownFragments: string[];

  constructor(knownFragments: string[]) {
    super(MESSAGE);
    this.knownFragments = knownFragments;
  }
}

const isState = (table: string): boolean => /^\[hooks\.state[\].]/.test(table);
// Each part opens with a table header and owns every line up to the next one.
const tables = (text: string): string[] => text.split(/^(?=\[)/m);

// Returns the config with the trust tables behind the end marker and the tail in
// the block, or undefined unless the block without its trust tables is the exact
// start of a known fragment whose exact rest follows the marker, with nothing but
// trust tables in between. Matching, refusals and the rewrite stay with the caller.
export function reanchorSplitManagedBlock(
  config: string, startMarker: string, endMarker: string, knownFragments: string[],
): string | undefined {
  const start = config.indexOf(startMarker);
  const end = start < 0 ? -1 : config.indexOf(endMarker, start);
  if (end < 0 || config[end - 1] !== "\n") return undefined;
  const body = tables(config.slice(start + startMarker.length, end));
  const head = body.filter((table) => !isState(table)).join("").trim();
  const after = config.slice(end + endMarker.length);
  if (!head || (after && !after.startsWith("\n"))) return undefined;
  // In TOML, the keys between the marker and the next table belong to the last
  // table of the block. They may move only along with a trust table.
  const firstTable = after.search(/^\[/m);
  const separated = firstTable < 0 ? after : after.slice(0, firstTable);
  if (separated.trim() && !isState(body.at(-1) ?? "")) return undefined;
  const following = firstTable < 0 ? [] : tables(after.slice(firstTable));
  const between = following.findIndex((table) => !isState(table));
  if (between < 0) return undefined;
  const rest = following.slice(between).join("");
  const fragments = [...new Set(knownFragments.map((fragment) => fragment.trim()))]
    .sort((left, right) => right.length - left.length);
  for (const fragment of fragments) {
    if (!fragment.startsWith(`${head}\n`)) continue;
    const tail = fragment.slice(head.length).trim();
    if (!tail || !rest.startsWith(tail) || !/^(?:\n|$)/.test(rest.slice(tail.length))) continue;
    const moved = [...body.filter(isState), separated.slice(1), ...following.slice(0, between)]
      .join("").replace(/^\n+|\n+$/g, "");
    const remainder = rest.slice(tail.length).replace(/^\n+/, "");
    return `${config.slice(0, start)}${startMarker}\n${fragment}\n${endMarker}\n`
      + (moved ? `\n${moved}\n` : "") + (remainder ? `\n${remainder}` : "");
  }
  return undefined;
}

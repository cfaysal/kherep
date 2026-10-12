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

// Issue #397. The checkout hooks run from the checkout or source pin the
// installer ran from, so a block from an earlier pin names another directory
// before them. The same hooks control-plane-hook-path.mts points at the current
// checkout in a whole block; here they take the fragment's own directory, and
// nothing else in the text may differ.
const CHECKOUT_DIR = /(?<=\\")(?:[^"\\]|\\\\)*?(?:\\\\|\/)modules(?:\\\\|\/)control-plane(?:\\\\|\/)node(?:\\\\|\/)(?=(?:deliver|attribution)-hook\.mts\\" \\"--runtime\\" \\"codex\\")/g;

function atCheckoutOf(fragment: string): (text: string) => string {
  const dirs = new Set(Array.from(fragment.matchAll(CHECKOUT_DIR), ([dir]) => dir));
  if (dirs.size !== 1) return (text) => text;
  const [dir] = dirs;
  return (text) => text.replace(CHECKOUT_DIR, () => dir);
}

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
  if (!head || !after.startsWith("\n")) return undefined;
  const firstTable = after.search(/^\[/m);
  if (firstTable < 0) return undefined;
  // In TOML, the keys between the marker and the next table belong to the last
  // table of the block. They may move only along with a trust table.
  const separated = after.slice(0, firstTable);
  if (separated.trim() && !isState(body.at(-1) ?? "")) return undefined;
  const following = tables(after.slice(firstTable));
  const tailIndex = following.findIndex((table) => !isState(table));
  if (tailIndex < 0) return undefined;
  const restTables = following.slice(tailIndex);
  const moved = [...body.filter(isState), separated.slice(1), ...following.slice(0, tailIndex)]
    .join("").replace(/^\n+|\n+$/g, "");
  const fragments = knownFragments.map((fragment) => fragment.trim()).sort((left, right) => right.length - left.length);
  for (const fragment of fragments) {
    const atCheckout = atCheckoutOf(fragment);
    const ownHead = atCheckout(head);
    if (!fragment.startsWith(`${ownHead}\n`)) continue;
    const tail = fragment.slice(ownHead.length).trim();
    // Only the tables the tail can cover are compared at the fragment's
    // checkout; whatever follows them stays as written.
    const covered = tables(tail).length;
    const rest = atCheckout(restTables.slice(0, covered).join("")) + restTables.slice(covered).join("");
    if (rest !== tail && !rest.startsWith(`${tail}\n`)) continue;
    const remainder = rest.slice(tail.length).replace(/^\n+/, "");
    return `${config.slice(0, start)}${startMarker}\n${fragment}\n${endMarker}\n`
      + (moved ? `\n${moved}\n` : "") + (remainder ? `\n${remainder}` : "");
  }
  return undefined;
}

# Atlassian brokers

The brokers write work items and wiki pages through separately configured runtime service identities. No site, space, work-item type or account is supplied by the repository.

The directory is named after Jira for historical reasons and also holds the Confluence brokers. That is deliberate: the installers copy this directory flat into `<workspace>/tools/`, so every relative import has to resolve inside a single directory. A separate directory would import across a boundary that exists in the checkout and not in an installed workspace.

## Operator configuration

Provide these environment variables to the runtime invoking the broker. Keep actual values in operator-owned configuration outside Git.

| Variable | Required value |
| --- | --- |
| `KHEREP_ATL_SITE` | HTTPS origin of the Jira site, without embedded credentials, a path, query or fragment |
| `KHEREP_ATL_PROJECT_ID` | Numeric space ID from that site |
| `KHEREP_ATL_PROJECT_KEY` | Space key used in work-item keys |
| `KHEREP_ATL_ISSUE_TYPES` | Non-empty JSON object mapping work-item type names to their numeric ID strings |
| `KHEREP_ATL_CRED_FILE_CODEX` | External service-account binding used only by the Codex broker |
| `KHEREP_ATL_CRED_FILE_CLAUDE` | External service-account binding used only by the Claude broker |

For example, `{"Task":"10001"}` illustrates the type-map format. The name and ID must come from the configured site; the example is not a default. Jira's REST API retains `project` and `issue` terminology.

The Jira brokers' `selftest` reads only `KHEREP_ATL_SITE` and the runtime's credential binding: it proves the service-account client and the site, never a project. Every other verb also needs the project values.

The Atlassian MCP server is a separate path with a separate credential: each runtime reaches it with a service-account API key in `KHEREP_ATL_MCP_TOKEN_FILE_CLAUDE` or `KHEREP_ATL_MCP_TOKEN_FILE_CODEX`, never with the broker files above. See [Atlassian MCP server](../../docs/INSTALLATION.md#atlassian-mcp-server).

## Arguments and help

All four brokers take `help` (also `--help` or `-h`) and list every verb with its required flags, alternatives in `( | )` and `[optional]` flags, with exit 0 and without reading configuration or credentials. The Codex Jira broker keeps its JSON-only stdout and returns the list as `{"usage": [...]}`.

Arguments are strict. A positional argument, an unknown flag, a flag without a value, a repeated flag or a missing required flag is refused before any configuration, credential or network access. The message names the verb's full syntax and, for a positional, the call it probably meant, for example `Did you mean: get --id 275907063`. `search` reports such a refusal as `status: unavailable` with exit 2, because its exit 1 means a search that ran and matched nothing. The Jira brokers answer in German, the Confluence brokers in English.

The flags each verb reads are declared once per broker in a `FLAGS` table; the parser and the help text are both generated from it by `atlassian-cli-args.mts`. That module installs with the default Confluence set, beside `atlassian-credentials.mts`, because both broker families import it.

## Confluence brokers

`atl-confluence-ccoder.mts` (Claude) and `atl-confluence.mts` (Codex) read the same two credential variables as their Jira counterparts and the same `KHEREP_ATL_SITE`. They need no space or page binding: a space is resolved from its key at call time.

Verbs: `create`, `update`, `get`, `delete`, `purge`, `labels`, `move`, `space`, `children`, `related`, `search`, `list`, `context`, `orphans`, `stitch`, `selftest`. `create` and `update` take page bodies with `--format storage|wiki|adf`; there is no markdown representation in this API and an unmapped format is refused before any request. `delete` moves a page to the trash, `purge` permanently removes an already trashed page and additionally requires the `manage/content` space permission. `move --id <page> --parent <node>` changes only the parent, leaves the body it read unchanged, and reports the new parent's own child list rather than the answer to the write.

`get --id <page>` prints the page metadata lines. `get --id <page> --body-only [--format storage|adf]` reads the current body in one request (`body-format=storage` by default, `atlas_doc_format` for `adf`) and prints it to stdout and nothing else: no metadata line and no added trailing newline, so `get --id <page> --body-only > page.xml` yields exactly the body. The broker writes no file itself. Without a redirect the body lands in the caller's output, for an agent that is its transcript. Errors go to stderr with a non-zero exit and an empty stdout: an unmapped or empty `--format` (checked before any request), `--format` without `--body-only`, a missing or non-numeric `--id`, a page that cannot be read, and an answer without the requested representation.

`search --space <key> --query "<terms>" [--limit N]` is the read-only research lookup: the semantic search proposes, and only leaf pages of that space survive, in proposal order (default 3). Each hit prints id, title, the page's `evidence-*` label and its URL. The semantic search is asked for `min(max(N, 25), 100)` proposals; 100 is the `twg rovo search` maximum, and it returns one ranked set with no total. After the hits, `truncated: true` means more pages may match: `--limit` cut off a further matching page, the proposals filled the request, or `--limit` was above 100. `truncated: false` means every matching proposal is shown and the semantic search returned fewer proposals than requested. Exit 0 means hits, 1 means the search ran and nothing in the space matched, 2 means the search could not run and the result is UNKNOWN (`status: unavailable`). `search` is not an inventory; use `list` to count pages.

The semantic search behind `search`, `related` and `stitch` runs the `twg` executable directly, without a shell. It is found in this order: `KHEREP_TWG_BIN` (an absolute path to the file; set but unusable, the search does not run rather than fall back), then `PATH`, then the install locations `~/.local/bin/twg`, `/opt/homebrew/bin/twg` and `/usr/local/bin/twg`, on Windows `twg.exe` on `PATH`, then `%LOCALAPPDATA%\Programs\twg\bin\twg.exe` and `%ProgramFiles%\twg\twg.exe`. A process whose `PATH` lacks `~/.local/bin`, such as a macOS background job, therefore still finds a CLI installed there. When none is found the search did not run and the result is UNKNOWN, never zero hits.

`list --space <key> [--title-contains <text>] [--label <name>] [--limit N]` is the read-only inventory of a space. It reads every page of the space through the paginated v2 pages endpoint. `--title-contains` keeps titles that contain the text, case-insensitively, compared in the broker rather than by CQL `title ~`, which is fuzzy. `--label` reads the pages with that label through one v1 CQL query (`space="<key>" and type=page and label="<name>"`, values JSON-quoted), follows `_links.next`, and keeps only pages that are also in the space index. Each page prints `page`, id, title and URL, tab-separated, followed by `total:` (the number of matching pages, counted by reading every result page, never taken from `totalSize`), `shown:` and `truncated:`. Only `--limit` truncates the rows; `total:` still counts every match. Exit 0 means the read completed, including `total: 0`. Exit 1 means a Confluence or argument error; a failed read prints no rows and no `total:`. `list` adds no scope: a permission error names `read:page:confluence`, as for `get`, and the `--label` query uses the same v1 CQL search endpoint that `related` already uses.

`stitch --space <key> [--id <id>]` writes the link to an orphan onto the pages it belongs next to, in a `Related pages` block at the end of the neighbour's body. A neighbour whose block already links every page the run would put there is counted as `unchanged` and not written. That decision is made on the page ids the block links, not on the bytes Confluence returns, so a block Confluence hands back re-serialized is still recognised and a second run on the same orphan writes nothing. A changed title of an already linked page is therefore not refreshed by itself; the block is rewritten, with current titles, only when a page is added or a link to a page no longer in the space is dropped.

`create` reads the page back and reports the `authorId` it finds there. That readback, not the create response, is the evidence that a page belongs to the service account; Confluence authorship cannot be changed after creation.

Labels are written by two verbs only, `create` and `labels`; every other verb reads them at most. Both service accounts are shared per runtime family, so the computed `runtime-<runtime>-<host>` label is the only record of which host produced a page, and the broker never takes it from the caller: a `runtime-` value passed in `--labels` is dropped. `create` always gives the new page the computed runtime label, with or without `--labels`. `labels --id <page>` alone is read-only: one GET, printed as `labels: a, b` or `labels: none`. `labels --id <page> --labels a,b` reads the page's labels first; when the page already carries a runtime label, only `a,b` are posted and the broker prints `runtime: kept <label>`, otherwise the computed label is posted with them and it prints `runtime: added <label>`. A call that would add nothing but a runtime label to a page that already has one is refused with exit 1 and no write. `--remove a,b` deletes labels and reads the rest back; it refuses a `runtime-` label.

`labels --id <page> --keep-runtime <runtime-label>` repairs the one known fault, a page with two runtime labels. It cannot be combined with `--labels` or `--remove`. It refuses with exit 1 and without writing when the value is not a `runtime-` label, when the page carries one, none or more than two runtime labels, or when the named label is not among them. Otherwise it deletes the other runtime label, reads the labels back and prints `runtime: kept <label>`, `runtime: removed <label>` and `labels: ...`; a removed label that is still there afterwards is exit 1. Which label is true is the operator's call, not the broker's: the shared service-account author cannot tell the hosts apart.

Missing or invalid bindings stop the operation. Neither broker falls back to the other runtime's credentials or an author's account. The installer preserves operator settings but does not invent these values. Configure them before using the brokers after upgrading from a deployment with embedded bindings.

Run `npm run test:brokers` from the repository root for synthetic configuration, authority and request tests. A passing test suite does not verify access to an operator's real Jira site.

## Brain drainage

The manually invoked `brain-drainage` skill is installed for Claude and Codex. It uses each runtime's configured service-account broker and space. Classification precedes tool use: page IDs, versions and structural findings can be private too. The scanner performs local structural analysis and emits no body excerpts or titles. Private content requires an authorized local route with no private outputs returning to a cloud model. Without that route, exclude known pages or stop the dependent review. The output flag records that preflight decision; it does not grant access.

```text
<configured broker> drainage --space <key> --metadata-approved
<configured broker> drainage --space <key> --ids <id,id> --exclude-ids <id,id> --metadata-approved
```

The JSON report contains candidate rows with page ID, read version, problem, proposed action class, bounded structural evidence and uncertainty. Scope, exclusions, counts, read errors and time span are separate from semantic review, which remains UNKNOWN. Inventory status is `complete`, `partial` or `failed`; exit 0 means the requested inventory completed, exit 2 means incomplete coverage, and exit 1 means invalid arguments or setup. A subset can have complete requested coverage while its space graph remains unevaluated. Hidden pages are outside visible coverage. Empty candidates never prove the space clean.

The scanner uses GET only, follows endpoint-bound pagination, brackets page/label reads for observed drift, and repeats inventory before graph evaluation. Stalled, looping, malformed and escaping cursors fail visibly. These are bracket reads, not an atomic snapshot. Incoming-link findings describe only explicit page-ID links in the complete visible current graph, not hierarchy navigation or external links. Near duplicates use meaningful content, excluding Related navigation. Code-bound observations with missing or invalid Revision lines, explicit search-only link justification and tracker-status wording become review candidates. No tracker lookup or content judgment is fabricated. Historical measurements remain valid in their original scope even after later fixes.

No findings are automatically applied. The Maestro reviews permitted content and concrete diffs, obtains explicit repair authority, reads target identity/body/version/labels, and uses:

```text
<configured broker> update --id <id> --format storage --body-file <reviewed-file> --expected-version <n>
```

Both update CLIs accept `--expected-version`. The shared update function re-reads immediately before PUT, rejects missing/invalid versions or mismatch without writing, and sends the reviewed version plus one. Guarded storage/ADF updates compare the target ID, space, title, status, version and body after PUT. Wiki input cannot provide exact API body readback and is refused for guarded updates. A failed readback may follow an actual write: report UNVERIFIED and investigate before retrying. Legacy calls without the flag retain their previous behavior; the maintenance skill always supplies it. Independently read the target after repair. Body updates preserve labels by leaving them untouched. Labels and multiple pages are separate operations without atomicity.

The [review rules](../../claude/skills/brain-drainage/references/review-rules.md) cover historical evidence, duplicate scope, original revision recovery, provenance links and graph limits. This feature adds no daemon, database, scheduler, scopes or credentials.

### Confirm path

Step 7 of the skill measures an `evidence-assumed` page against its primary source and proposes `evidence-confirmed`, `evidence-refuted` or `evidence-superseded`. It runs only on operator request, per page. Both brokers expose the same `evidence` verb, implemented in `confluence-evidence.mts` (pure gates, no I/O), `confluence-evidence-report.mts` (record type and report, no I/O), `confluence-evidence-io.mts` (git, file and record I/O) and `confluence-evidence-cli.mts` (the modes). The verb sends GET requests only; it never writes to Confluence.

```text
<configured broker> evidence --mode prepare --id <id> --space <key> --body-approved --out <record.json>
<configured broker> evidence --mode decide --record <record.json> --measurement <m.json> --out-body <body.xml> [--repo-root <checkout>] [--superseded-by <id> --body-approved] [--max-age-days <n>]
<configured broker> evidence --mode report --records <r1.json,r2.json>
<configured broker> evidence --mode verify --record <record.json> --body-file <body.xml>
<configured broker> evidence --mode record --id <id> --excluded private|unavailable --reason <slug> --out <record.json>
```

- `prepare` takes a bracketed snapshot (the scanner's code), classifies the claim (`code`, `tracker`, `live`, `doc`, `historical`, `unclassified`) and writes a record holding the body and title. Record and body files must lie outside every git work tree; the broker refuses a path inside one, and refuses whenever git does not answer "not a git repository" for its directory (git cannot run, dubious ownership, a missing directory). The check runs on the resolved real directory, so a symlinked directory cannot point into a work tree. `prepare` and `record` refuse an existing `--out` (`out-exists`); `decide` replaces the record and body atomically (a temporary file in the same directory, then a rename). A record whose `labels` is not a list of strings is refused as malformed. Stdout carries ids, versions, kind, labels and counts only.
- `decide` applies the gates offline and names the first failing one: eligible type and `evidence-assumed`, a model-assigned status, a body-approved record, a known measurement schema from an allowed source class, an excerpt of at most 4000 characters without credential-shaped content or C0 control characters other than tab, LF and CR (CRLF and lone CR become LF in every field before any gate), a measurement at most 2 days old (`--max-age-days` up to 7), a matching kind, and for code a Revision bound on the page and present in `--repo-root` (`git cat-file`, SHA validated first) whose directory name matches. `--repo-root` must therefore be the main checkout or a checkout whose directory is named after the repository; a linked worktree gives `repo-root-name-mismatch`. `--superseded-by` naming the page itself is refused (`superseded-same-page`). The measurement must name what the claim is about: for a tracker claim every tracker key the page states, matched as a whole key in the excerpt (a GitHub key `#N` only as the token `#N` in the excerpt or as the number `gh issue view N` or `gh pr view N` reads, never as a bare number such as a date); for a code claim any one of its file names or `subject`. A page classified `historical` stays `historical-not-repeatable` under any `--kind` override. Exit 0 writes the reviewed body with a dated measurement block before the `Related pages` footer, escaping only `&`, `<` and `>` in text and adding `"` only in attribute values, so Confluence's storage normalisation cannot turn the byte-exact `update` readback into UNVERIFIED; exit 2 leaves the page UNKNOWN or reported-only with a reason; exit 1 is malformed input. A promoted body is re-checked with the drainage rules before it is written.
- `report` prints per page the kind (a `--kind` override as `kind: <k> (override; classified <c>)` with the measurement's `kindOverride` reason), outcome, reason, label diff, passive labels (`currency-*`, `origin-wiki`) and, for every proposed change, the command, excerpt and verdict verbatim. It prints no titles or bodies.
- Writes stay with `update --expected-version` and `labels`, in that order: add `evidence-<outcome>`, then remove `evidence-assumed`. `verify` re-reads the page and prints `readback: match` only when the body bytes match and the full label set equals the reviewed one (exactly one evidence label, equal to the outcome); otherwise `readback: mismatch labels (+added, -missing)`. The reviewed set includes the broker's runtime label when the page carried none, because the `labels` call adds it. Before the first real run, the operator checks the `update` round trip on one page with an apostrophe, a quote and a multi-line excerpt in the block.

Human-assigned status is reported, never relabelled. `status-author-*`, `currency-*`, `origin-wiki`, `session-*` and `product-*` are never changed. A `runtime-*` label is never removed or changed; the broker adds its own only when the page has none. Private pages are registered with `record` without a read and stay UNKNOWN in a cloud session. A format repair still never promotes.

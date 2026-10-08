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

## Arguments and help

All four brokers take `help` (also `--help` or `-h`) and list every verb with its required flags, alternatives in `( | )` and `[optional]` flags, with exit 0 and without reading configuration or credentials. The Codex Jira broker keeps its JSON-only stdout and returns the list as `{"usage": [...]}`.

Arguments are strict. A positional argument, an unknown flag, a flag without a value, a repeated flag or a missing required flag is refused before any configuration, credential or network access. The message names the verb's full syntax and, for a positional, the call it probably meant, for example `Did you mean: get --id 275907063`. `search` reports such a refusal as `status: unavailable` with exit 2, because its exit 1 means a search that ran and matched nothing. The Jira brokers answer in German, the Confluence brokers in English.

The flags each verb reads are declared once per broker in a `FLAGS` table; the parser and the help text are both generated from it by `atlassian-cli-args.mts`. That module installs with the default Confluence set, beside `atlassian-credentials.mts`, because both broker families import it.

## Confluence brokers

`atl-confluence-ccoder.mts` (Claude) and `atl-confluence.mts` (Codex) read the same two credential variables as their Jira counterparts and the same `KHEREP_ATL_SITE`. They need no space or page binding: a space is resolved from its key at call time.

Verbs: `create`, `update`, `get`, `delete`, `purge`, `labels`, `move`, `space`, `children`, `related`, `search`, `list`, `context`, `orphans`, `stitch`, `selftest`. `create` and `update` take page bodies with `--format storage|wiki|adf`; there is no markdown representation in this API and an unmapped format is refused before any request. `delete` moves a page to the trash, `purge` permanently removes an already trashed page and additionally requires the `manage/content` space permission. `move --id <page> --parent <node>` changes only the parent, leaves the body it read unchanged, and reports the new parent's own child list rather than the answer to the write.

`get --id <page>` prints the page metadata lines. `get --id <page> --body-only [--format storage|adf]` reads the current body in one request (`body-format=storage` by default, `atlas_doc_format` for `adf`) and prints it to stdout and nothing else: no metadata line and no added trailing newline, so `get --id <page> --body-only > page.xml` yields exactly the body. The broker writes no file itself. Without a redirect the body lands in the caller's output, for an agent that is its transcript. Errors go to stderr with a non-zero exit and an empty stdout: an unmapped or empty `--format` (checked before any request), `--format` without `--body-only`, a missing or non-numeric `--id`, a page that cannot be read, and an answer without the requested representation.

`search --space <key> --query "<terms>" [--limit N]` is the read-only research lookup: the semantic search proposes, and only leaf pages of that space survive, in proposal order (default 3). Each hit prints id, title, the page's `evidence-*` label and its URL. The semantic search is asked for `min(max(N, 25), 100)` proposals; 100 is the `twg rovo search` maximum, and it returns one ranked set with no total. After the hits, `truncated: true` means more pages may match: `--limit` cut off a further matching page, the proposals filled the request, or `--limit` was above 100. `truncated: false` means every matching proposal is shown and the semantic search returned fewer proposals than requested. Exit 0 means hits, 1 means the search ran and nothing in the space matched, 2 means the search could not run and the result is UNKNOWN (`status: unavailable`). `search` is not an inventory; use `list` to count pages.

`list --space <key> [--title-contains <text>] [--label <name>] [--limit N]` is the read-only inventory of a space. It reads every page of the space through the paginated v2 pages endpoint. `--title-contains` keeps titles that contain the text, case-insensitively, compared in the broker rather than by CQL `title ~`, which is fuzzy. `--label` reads the pages with that label through one v1 CQL query (`space="<key>" and type=page and label="<name>"`, values JSON-quoted), follows `_links.next`, and keeps only pages that are also in the space index. Each page prints `page`, id, title and URL, tab-separated, followed by `total:` (the number of matching pages, counted by reading every result page, never taken from `totalSize`), `shown:` and `truncated:`. Only `--limit` truncates the rows; `total:` still counts every match. Exit 0 means the read completed, including `total: 0`. Exit 1 means a Confluence or argument error; a failed read prints no rows and no `total:`. `list` adds no scope: a permission error names `read:page:confluence`, as for `get`, and the `--label` query uses the same v1 CQL search endpoint that `related` already uses.

`create` reads the page back and reports the `authorId` it finds there. That readback, not the create response, is the evidence that a page belongs to the service account; Confluence authorship cannot be changed after creation.

Labels are written by two verbs only, `create` and `labels`; every other verb reads them at most. Both service accounts are shared per runtime family, so the computed `runtime-<runtime>-<host>` label is the only record of which host produced a page, and the broker never takes it from the caller: a `runtime-` value passed in `--labels` is dropped. `create` always gives the new page the computed runtime label, with or without `--labels`. `labels --id <page>` alone is read-only: one GET, printed as `labels: a, b` or `labels: none`. `labels --id <page> --labels a,b` reads the page's labels first; when the page already carries a runtime label, only `a,b` are posted and the broker prints `runtime: kept <label>`, otherwise the computed label is posted with them and it prints `runtime: added <label>`. A call that would add nothing but a runtime label to a page that already has one is refused with exit 1 and no write. `--remove a,b` deletes labels and reads the rest back; it refuses a `runtime-` label.

`labels --id <page> --keep-runtime <runtime-label>` repairs the one known fault, a page with two runtime labels. It cannot be combined with `--labels` or `--remove`. It refuses with exit 1 and without writing when the value is not a `runtime-` label, when the page carries one, none or more than two runtime labels, or when the named label is not among them. Otherwise it deletes the other runtime label, reads the labels back and prints `runtime: kept <label>`, `runtime: removed <label>` and `labels: ...`; a removed label that is still there afterwards is exit 1. Which label is true is the operator's call, not the broker's: the shared service-account author cannot tell the hosts apart.

Missing or invalid bindings stop the operation. Neither broker falls back to the other runtime's credentials or an author's account. The installer preserves operator settings but does not invent these values. Configure them before using the brokers after upgrading from a deployment with embedded bindings.

Run `npm run test:brokers` from the repository root for synthetic configuration, authority and request tests. A passing test suite does not verify access to an operator's real Jira site.

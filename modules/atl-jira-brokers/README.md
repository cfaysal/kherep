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

## Confluence brokers

`atl-confluence-ccoder.mts` (Claude) and `atl-confluence.mts` (Codex) read the same two credential variables as their Jira counterparts and the same `KHEREP_ATL_SITE`. They need no space or page binding: a space is resolved from its key at call time.

Verbs: `create`, `update`, `get`, `delete`, `purge`, `labels`, `move`, `space`, `children`, `related`, `context`, `orphans`, `stitch`, `selftest`. Page bodies are passed with `--format storage|wiki|adf`; there is no markdown representation in this API and an unmapped format is refused before any request. `delete` moves a page to the trash, `purge` permanently removes an already trashed page and additionally requires the `manage/content` space permission. `move --id <page> --parent <node>` changes only the parent, leaves the body it read unchanged, and reports the new parent's own child list rather than the answer to the write.

`create` reads the page back and reports the `authorId` it finds there. That readback, not the create response, is the evidence that a page belongs to the service account; Confluence authorship cannot be changed after creation.

Missing or invalid bindings stop the operation. Neither broker falls back to the other runtime's credentials or an author's account. The installer preserves operator settings but does not invent these values. Configure them before using the brokers after upgrading from a deployment with embedded bindings.

Run `npm run test:brokers` from the repository root for synthetic configuration, authority and request tests. A passing test suite does not verify access to an operator's real Jira site.

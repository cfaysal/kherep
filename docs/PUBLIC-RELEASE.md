# Public release review

A clean working tree is only one part of a public release. Review the exact revision to publish, its reachable Git history, and the third-party material it redistributes.

## Content and configuration

- Keep sessions, internal project records, connection profiles, credentials, and private infrastructure inventories outside source control.
- Use synthetic identities and reserved domains in examples.
- Describe configured, tested, and running capabilities separately.
- Verify installation instructions in a disposable candidate and preserve recovery evidence outside the public tree.

Run the local publication audit with an external JSON array of organization-specific forbidden terms:

```bash
npm run audit:publication -- . /absolute/outside-repository/publication-policy.json
```

The audit inspects both indexed and working-tree bytes. It reports review categories, including binary assets, email addresses, private endpoints, sensitive filenames, and secret markers. Investigate each finding. Synthetic security fixtures and required upstream notices can trigger findings; document their review without weakening the audit. A failed or incomplete read is not a clean result.

## History and redistribution

Removing a file from the current tree leaves earlier versions in Git history. Review all refs intended for publication, including tags and branches. If private data was committed, prepare a sanitized history or a clean public export and obtain explicit authority before replacing remote history or changing repository visibility. Rotate any credential that was exposed; a history rewrite cannot revoke it.

Choose the project license explicitly. Preserve the licenses, attribution, and redistribution obligations of bundled third-party material. Check source snapshots and binary branding assets separately.

## Delivery

Run the checks required by [CONTRIBUTING.md](../CONTRIBUTING.md), inspect the final diff, and identify the candidate by its revision and file hashes. Obtain authority for the publication action and read back the exact revision and repository visibility at the destination before claiming delivery.

## Versions and releases

Kherep has one product version, `version` in the root `package.json`, following [Semantic Versioning](https://semver.org/). `package-lock.json`, the Codex plugin manifests and the newest release section of [CHANGELOG.md](../CHANGELOG.md) repeat it, and `bootstrap/version-contract.test.mts` keeps them equal. While the version is `0.y.z`, a release that breaks a documented interface increments the minor version; every other release increments the patch version.

A release is an annotated tag `vX.Y.Z` on the released commit. Push that tag explicitly by name, for example `git push origin refs/tags/vX.Y.Z`. Never push with `--tags`, `--mirror` or `--follow-tags`: they would publish every local tag.

The public repository receives an export of the released revision, never the private history. Build it with `node bootstrap/public-export.mts <revision> <outDir>`. The command writes the revision's tree without `.git` and without the paths in `bootstrap/manifest/public-export-exclude.txt`, fails if an excluded path or a symlink would remain, and writes a SHA-256 manifest beside the output directory. Run the publication audit and the checks above on that exported tree.

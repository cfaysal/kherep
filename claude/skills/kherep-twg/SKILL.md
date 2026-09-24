---
name: kherep-twg
description: Use when performing bounded, read-only Jira or Confluence lookups through an installed Teamwork Graph integration.
user-invocable: true
---

# Kherep Teamwork Graph Reads

Use the repository-provided Teamwork Graph wrapper or the installed vendor CLI for bounded read-only searches. Discover the wrapper path and supported commands from current project documentation or `--help`; do not assume a user directory, tenant, project key, CLI version, or authentication identity.

## Privacy and account gate

Classify the requested source and expected result before every read. Continue only when the active account is authorized for the requested tenant and the content is allowed in the current model context. Route private, customer-internal, credential-related, or unclassified content through the user's approved privacy workflow.

Do not echo raw diagnostic output that may include content or identifiers. A wrapper that limits fields reduces exposure but does not sanitize arbitrary Jira or Confluence text.

## Read workflow

1. Run the wrapper's status or doctor command.
2. Confirm authentication and tenant context without revealing identifiers.
3. Use only documented read operations for a single work item, bounded search, or content search.
4. Apply the wrapper's result cap and pagination rules.
5. Treat an empty response as "nothing found in this bounded query," never as proof of absence.

Mutations require a separately authorized write path. Do not infer write authority from read access.

## Setup

If the integration is missing, point the user to the current vendor installation and login instructions. Do not download, update, authenticate, or pin a version unless the user requested setup and the current official documentation supports the command.

## Output

Return the query scope, result count, concise findings, pagination or cap limits, and any unresolved access or privacy boundary. Omit account, tenant, and infrastructure identifiers unless the user explicitly needs them.

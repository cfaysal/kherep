---
name: codebase-memory
description: Use when exploring code structure, architecture, callers, callees, dependencies, impact, dead code, fan-out, or refactor candidates through an available knowledge graph.
---

# Codebase Memory - Knowledge Graph Tools

Graph tools return precise structural results without reading whole files.

## Quick Decision Matrix

| Question | Tool call |
|----------|----------|
| Who calls X? | `trace_path(direction="inbound")` |
| What does X call? | `trace_path(direction="outbound")` |
| Full call context | `trace_path(direction="both")` |
| Find by name pattern | `search_graph(name_pattern="...")` |
| Dead code | `search_graph(max_degree=0, exclude_entry_points=true)` |
| Cross-service edges | `query_graph` with Cypher |
| Impact of local changes | `detect_changes()` |
| Risk-classified trace | `trace_path(risk_labels=true)` |
| Text search | `search_code` or Grep |

## Exploration Workflow

1. `list_projects` - check if project is indexed
2. `get_graph_schema` - understand node/edge types
3. `search_graph(label="Function", name_pattern=".*Pattern.*")` - find code
4. `get_code_snippet(qualified_name="project.path.FuncName")` - read source

## Tracing Workflow

1. `search_graph(name_pattern=".*FuncName.*")` - discover exact name
2. `trace_path(function_name="FuncName", direction="both", depth=3)` - trace
3. `detect_changes()` - map git diff to affected symbols

## Quality Analysis

- Dead code: `search_graph(max_degree=0, exclude_entry_points=true)`
- High fan-out: `search_graph(min_degree=10, relationship="CALLS", direction="outbound")`
- High fan-in: `search_graph(min_degree=10, relationship="CALLS", direction="inbound")`

## MCP Tools

`index_repository`, `index_status`, `list_projects`, `delete_project`,
`search_graph`, `search_code`, `trace_path`, `detect_changes`,
`query_graph`, `get_graph_schema`, `get_code_snippet`, `get_architecture`,
`manage_adr`, `ingest_traces`

## Edge Types

CALLS, HTTP_CALLS, ASYNC_CALLS, IMPORTS, DEFINES, DEFINES_METHOD,
HANDLES, IMPLEMENTS, OVERRIDE, USAGE, FILE_CHANGES_WITH,
CONTAINS_FILE, CONTAINS_FOLDER, CONTAINS_PACKAGE

## Gotchas

1. `search_graph(relationship="HTTP_CALLS")` filters nodes by degree - use `query_graph` with Cypher to see actual edges.
2. Use `search_graph` with degree filters for counting broad results.
3. `trace_path` needs exact names - use `search_graph(name_pattern=...)` first.
4. `direction="outbound"` misses cross-service callers - use `direction="both"`.
5. Check `has_more` and use `offset` when results are paginated.

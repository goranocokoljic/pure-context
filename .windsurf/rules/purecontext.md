<!-- purecontext-mcp-start -->
## PureContext MCP — Code Navigation

Always use PureContext MCP tools for code navigation. Never read entire files to find code.

### Mandatory workflow

1. **Start every session**: `list_repos()` → get `repoId` (required for all tools)
2. **Find code by name**: `search_symbols` → read `summary` and `signature` → only call `get_symbol_source` for symbols you will actually edit
3. **Find code by behaviour**: `search_semantic` for conceptual queries; `search_text` for literals/comments

### Key tools

| Goal | Tool |
|------|------|
| Find function/class by name | `search_symbols` |
| Find by what it does | `search_semantic` |
| Find literal string or comment | `search_text` |
| All symbols in a file | `get_file_outline` |
| What breaks if I change this | `get_blast_radius` |
| All callers of a function | `find_references` |
| Callers/callees tree | `get_call_hierarchy` |

### Anti-patterns — never do these

- Do not read whole files to find a function — use `search_symbols` + `get_symbol_source`
- Do not call `get_symbol_source` for every result — read `summary` first
- Do not skip `list_repos` — every tool needs a `repoId`
- Do not re-search after `verdict: "no_match"` — the symbol does not exist
<!-- purecontext-mcp-end -->

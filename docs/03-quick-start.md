# Quick Start


## Step 1 — Connect to Claude Code

```bash
# Recommended: registers the server (pinned to your global Node) + adds workflow rules
npx purecontext-mcp install claude

# Or register the server manually with npx:
claude mcp add purecontext-mcp -- npx purecontext-mcp

# Or, if installed globally:
claude mcp add purecontext-mcp purecontext-mcp
```

Verify the connection:

```bash
claude mcp list
# purecontext-mcp   connected   npx purecontext-mcp
```

## Step 2 — Index your project

In a Claude Code conversation, ask:

> "Use index_folder to index /path/to/my-project."

Or more naturally:

> "Index this project so I can search its symbols."

Claude will call `index_folder`. A typical response looks like:

```json
{
  "repoId": "a1b2c3d4e5f60001",
  "filesIndexed": 342,
  "symbolsExtracted": 4821,
  "durationMs": 1240,
  "languages": ["typescript", "javascript"],
  "adapters": ["vue", "nuxt"]
}
```

Re-indexing is incremental — only files whose content has changed are re-parsed. You can call `index_folder` again at any time; it is fast on subsequent runs.

## Step 3 — Explore the project structure

```
Get the repo outline for my project.
```

Claude calls `get_repo_outline`, which returns all files and their top-level symbols — a token-efficient project map.

## Step 4 — Search for symbols

```
Search for functions named 'authenticate'.
```

Claude calls `search_symbols`:

```json
{
  "symbols": [
    {
      "id": "8f3a2c1d0e4b5f9a",
      "name": "authenticateUser",
      "kind": "function",
      "filePath": "src/auth/validator.ts",
      "signature": "function authenticateUser(credentials: Credentials): Promise<User>",
      "summary": "Validates user credentials and returns an authenticated User object."
    }
  ]
}
```

Note: `search_symbols` returns signatures and summaries — **no source code**. This keeps the response tiny.

## Step 5 — Retrieve source when you need it

```
Get the source for the authenticateUser symbol.
```

Claude calls `get_symbol_source` using the `id` from step 4 and gets back just those lines — not the whole file.

## Example workflow

```
User: "Find the authentication logic in this project."

Claude:
1. search_symbols(query: "auth", kind: "function")
   → Returns: authenticateUser, validateToken, hashPassword (3 matches, ~80 tokens)

2. get_symbol_source(symbolId: "authenticateUser-id")
   → Returns: 45 lines of source (~150 tokens)

Total: ~230 tokens
Without PureContext: read the 800-line auth file → ~2,000 tokens
Savings: 88%
```

## What to try next

| Task | Tool |
|------|------|
| See all symbols in a file | `get_file_outline` |
| Find what a function imports | `get_context_bundle` |
| Find what uses a function | `get_blast_radius` |
| Find unused exports | `find_dead_code` |
| Search by meaning, not name | `search_semantic` |
| Text search (like grep) | `search_text` |

## Connecting to a team server

If your team runs a shared PureContext server:

```bash
claude mcp add purecontext-remote \
  --transport http \
  --url https://purecontext.mycompany.com/mcp/sse \
  --header "Authorization: Bearer pctx_yourpersonalkey"
```

See [Team Setup](15-team-setup.md) for full instructions.

## Generating a config file

```bash
purecontext-mcp config --init
# Creates ~/.purecontext/config.json with defaults and comments
```

See [Configuration](04-configuration.md) for all available options.

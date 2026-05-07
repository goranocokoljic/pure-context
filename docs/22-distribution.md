# Distribution & Platform


PureContext supports distribution and automation through index export/import, a public registry of pre-built indexes, webhooks for auto-reindex, GitHub Actions integration, and a VS Code extension.

---

## Index export and import

Share pre-built indexes without requiring everyone to re-index from scratch.

### Export

```bash
npx purecontext-mcp export --repo <repoId> --out index.pctx.tar.gz
```

Or by path:

```bash
npx purecontext-mcp export --path /path/to/project --out index.pctx.tar.gz
```

The archive contains: compressed SQLite database, HNSW index (if present), and a metadata JSON file.

### Import

```bash
npx purecontext-mcp import --file index.pctx.tar.gz
```

After import, the repo is immediately searchable — no re-indexing required.

### Use cases

- **Team onboarding**: export the index after CI, share as an artifact — new developers get a pre-built index on day one
- **CI pipeline**: cache the index between runs (see GitHub Actions below)
- **Server migration**: move indexes from one server to another without re-indexing

---

## Public registry

Pre-built indexes for popular open-source projects are hosted on a CDN.

### Pulling a registry index

```bash
npx purecontext-mcp pull react@18
npx purecontext-mcp pull typescript@5
npx purecontext-mcp pull django@4.2
```

The index is downloaded and imported automatically. Use `list_repos` to confirm it's available.

### Available packages

```bash
npx purecontext-mcp registry list
# Lists all available packages with versions and index sizes
```

### Requesting a new package

Open an issue on GitHub with the package name and version. Registry indexes are built automatically from GitHub releases using the GitHub Actions integration.

---

## Webhooks for auto-reindex

Configure a webhook endpoint to trigger re-indexing automatically when code is pushed to your repository.

### Setup

1. In your PureContext server config:

```json
{
  "webhooks": {
    "enabled": true,
    "secret": "${WEBHOOK_SECRET}",
    "branches": ["main", "develop"]
  }
}
```

2. In your GitHub repository settings:
   - Go to Settings → Webhooks → Add webhook
   - Payload URL: `https://your-server/webhook/github`
   - Content type: `application/json`
   - Secret: same value as `WEBHOOK_SECRET`
   - Events: "Just the push event"

### How it works

When a push is received:
1. PureContext verifies the webhook signature (HMAC-SHA256)
2. Checks if the pushed branch is in `webhooks.branches`
3. Triggers an incremental re-index of the affected repo
4. New symbols are available within seconds

### GitLab and others

Custom webhook formats are supported by mapping them to PureContext's internal format:

```json
{
  "webhooks": {
    "enabled": true,
    "format": "gitlab",
    "secret": "${WEBHOOK_SECRET}"
  }
}
```

---

## GitHub Actions integration

The official `purecontext/index-action` automates index building in CI.

### Basic usage

```yaml
# .github/workflows/index.yml
name: Index with PureContext
on:
  push:
    branches: [main]

jobs:
  index:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Index repository
        uses: purecontext/index-action@v1
        with:
          server-url: ${{ vars.PCTX_SERVER_URL }}
          api-key: ${{ secrets.PCTX_API_KEY }}
```

### Caching the index in CI

```yaml
- name: Cache PureContext index
  uses: actions/cache@v4
  with:
    path: ~/.purecontext/indexes
    key: purecontext-${{ github.sha }}
    restore-keys: purecontext-

- name: Index repository
  uses: purecontext/index-action@v1
  with:
    path: ${{ github.workspace }}
```

With caching, only changed files are re-parsed on each run — CI index time drops to seconds after the first run.

### Publishing to the registry

```yaml
- name: Publish index to registry
  uses: purecontext/index-action@v1
  with:
    action: publish
    package-name: my-org/my-library
    api-key: ${{ secrets.PCTX_REGISTRY_KEY }}
```

See the full `action.yml` in the project root for all available inputs.

---

## VS Code extension

The PureContext VS Code extension integrates symbol search and navigation directly into the editor.

### Installation

Search "PureContext" in the VS Code Extensions panel, or:

```bash
code --install-extension purecontext.purecontext-vscode
```

The source is in `vscode-extension/` in the project repo.

### Features

| Feature | Description |
|---------|-------------|
| Symbol search | `Ctrl+Shift+P` → "PureContext: Search Symbols" |
| Hover summary | Hover over any identifier to see its PureContext summary |
| Go to definition | Uses PureContext index for faster lookup in large repos |
| Dependency graph | `Ctrl+Shift+P` → "PureContext: Show Dependencies" — opens graph panel |
| Blast radius | Right-click a symbol → "Show Blast Radius" |
| Quick outline | `Ctrl+Shift+O` with PureContext — shows AI-enriched summaries |

### Configuration

Extension settings in VS Code match the `config.json` fields:

```json
// .vscode/settings.json
{
  "purecontext.serverUrl": "http://localhost:3000",
  "purecontext.apiKey": "pctx_...",
  "purecontext.enabled": true
}
```

---

## Programmatic API

For building custom integrations, the `@purecontext/client` npm package provides a typed TypeScript client:

```typescript
import { PureContextClient } from '@purecontext/client';

const client = new PureContextClient({
  serverUrl: 'http://localhost:3000',
  apiKey: 'pctx_...'
});

const symbols = await client.searchSymbols({
  repoId: 'a1b2c3d4',
  query: 'authenticate',
  kind: 'function'
});
```

All tool inputs and outputs are fully typed. Install:

```bash
npm install @purecontext/client
```

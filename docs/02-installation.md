# Installation — Reference

This is the reference page for installation: prerequisites, prebuilt-binary support matrix, verification commands, and upgrade paths.

For the **user-friendly walkthrough** — per-IDE setup, agent-instructions installer, team server connection — see [`FULL-INSTALLATION-GUIDE.md`](../FULL-INSTALLATION-GUIDE.md) at the project root.

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | >= 18.0.0 | 18, 20, and 22 are tested |
| npm | >= 9.0.0 | Ships with Node 18+ |
| Git | any | Required only for `index_repo` (cloning remote repositories) |

---

## Install commands

```bash
# Recommended: run via npx (no global install needed)
npx purecontext-mcp@latest

# Or install globally
npm install -g purecontext-mcp@latest
```

The `@latest` tag is recommended in AI-client configurations so new versions are picked up without manual upgrade steps.

---

## Prebuilt binary support matrix

`better-sqlite3` is the only native dependency. Prebuilt binaries are bundled for:

| Platform | Node 18 | Node 20 | Node 22 |
|----------|:-------:|:-------:|:-------:|
| Windows x64 | ✓ | ✓ | ✓ |
| macOS x64 | ✓ | ✓ | ✓ |
| macOS arm64 | ✓ | ✓ | ✓ |
| Linux x64 | ✓ | ✓ | ✓ |
| Linux arm64 | ✓ | ✓ | ✓ |

When your platform matches a row above, `npm install` completes with zero native compilation. For unsupported combinations, `npm install` falls back to a source build, which requires Python 3.x, a C++ toolchain, and `node-gyp`.

---

## Verification

```bash
purecontext-mcp --version
purecontext-mcp config --check
```

`config --check` validates the install: confirms Node and SQLite versions, verifies all 34 grammar WASM files load, and reports the effective configuration.

---

## Upgrade matrix

| How you installed | Command to upgrade |
|-------------------|--------------------|
| Volta | `volta install purecontext-mcp` |
| npm global | `npm install -g purecontext-mcp@latest` |
| npx (cached) | `npx purecontext-mcp@latest` (forces a fresh fetch) |
| Source / clone | `git pull && npm install && npm run build` |

> `npm update -g` is not reliable for this package — use `npm install -g ...@latest`.

**Index compatibility:** SQLite indexes are forward-compatible within a major version (`1.x` → `1.y` keeps existing indexes). Major upgrades (`1.x` → `2.0`) may require a re-index; the CLI warns when it detects an incompatible index.

---

## Uninstall

```bash
npm uninstall -g purecontext-mcp
rm -rf ~/.purecontext   # removes indexes, config, savings stats
```

---

## Related reference

- [Configuration](04-configuration.md) — full `config.json` schema and environment variable overrides
- [CLI Reference](05-cli-reference.md) — every command and flag
- [Transport Modes](14-transport-modes.md) — stdio vs HTTP/SSE deployment
- [Team Setup & Multi-Tenant](15-team-setup.md) — reference for shared-server config

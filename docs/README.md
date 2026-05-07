# PureContext MCP — User Manual

PureContext MCP indexes your codebase and gives AI agents a way to navigate it without reading entire files. Instead of loading hundreds of lines of code to find one function, Claude (or any other MCP-compatible AI) can search by name, retrieve just the symbol it needs, and understand the dependency chain — all in a fraction of the tokens.

This manual covers everything from installation through advanced features. Use the sections below to navigate to what you need, or read in order for a full introduction.

---

## Getting Started

These three sections get you from zero to a working setup.

- [Introduction](01-introduction.md) — What PureContext is, why token efficiency matters, key concepts
- [Installation](02-installation.md) — Install via npm, verify your setup, upgrade and uninstall
- [Quick Start](03-quick-start.md) — Index a project and search your first symbol in minutes

---

## Reference

Complete reference material for configuration, the CLI, and every MCP tool.

- [Configuration](04-configuration.md) — Full `config.json` schema, every field explained, environment variable overrides
- [CLI Reference](05-cli-reference.md) — Every command and flag: `config --init`, `--health`, `--transport`, and more
- [MCP Tools Reference](06-tools-reference.md) — Every tool with inputs, outputs, and examples — grouped by category

---

## Language & Framework Support

- [Language Support](07-language-support.md) — All 34 supported languages: what gets indexed and known limitations
- [Framework Adapters](08-framework-adapters.md) — Vue, React, Nuxt, Next.js, Angular, NestJS, Express, Django, Rails, Spring, and 20+ more

---

## Core Features

- [Dependency Graph Tools](09-dependency-graph.md) — Find what a symbol depends on, what depends on it, and what is dead code
- [Semantic Search](10-semantic-search.md) — Search by meaning rather than name using HNSW vector index
- [Search Quality & Ranking](11-search-quality.md) — How FTS5, camelCase splitting, and relevance ranking work; search tips
- [AI Summarization](12-ai-summarization.md) — Auto-generate symbol descriptions with Anthropic, OpenAI, or Gemini
- [Token Savings Tracker](13-token-savings.md) — See exactly how many tokens (and dollars) PureContext saves per session

---

## Deployment

- [Transport Modes](14-transport-modes.md) — stdio (local) vs HTTP/SSE (team/browser); TLS via reverse proxy
- [Team Setup & Multi-Tenant](15-team-setup.md) — Shared server, workspaces, API keys, rate limiting
- [Docker Deployment](16-docker.md) — `docker run`, Docker Compose, volumes, environment variables, health checks

---

## Advanced Features

- [Web UI](17-web-ui.md) — Visual graph viewer, heatmap, symbol timeline, test coverage overlay
- [Git & History Integration](18-git-history.md) — Symbol-level commit history, churn metrics, PR diff analysis
- [Cross-Repo Intelligence](19-cross-repo.md) — Search across multiple repos, find similar code, MCP Resources
- [AI-Powered Architecture Analysis](20-architecture-analysis.md) — Quality metrics, anti-pattern detection, auto-generated architecture docs
- [Ecosystem & Data Tools](21-ecosystem-tools.md) — dbt integration, OpenAPI/Swagger handler, SQL handler, column search
- [Distribution & Platform](22-distribution.md) — Index export/import, public registry, webhooks, GitHub Actions, VS Code extension

---

## Operations & Reference

- [Performance & Scalability](23-performance.md) — Worker thread pool, large repo tuning, memory usage
- [Security](24-security.md) — API key model, workspace isolation, path traversal prevention, hardening checklist
- [Troubleshooting](26-troubleshooting.md) — Common errors, `--health` output, debug logging, re-indexing from scratch
- [Architecture Overview](25-architecture-overview.md) — How PureContext works internally: three-layer design, data flow, SQLite schema
- [API Stability & Changelog](27-api-stability.md) — Semver policy, stable vs experimental tools, version history

# PureContext MCP — Reference Manual

This is the **reference manual**: parameter-level documentation for every tool, configuration option, language handler, framework adapter, and deployment option.

For the **user guide** — narrative explanations, worked examples, and real-world workflows — see [`USER-GUIDE.md`](../USER-GUIDE.md) and the `WHY-PURECONTEXT.md` / `FINDING-CODE.md` / `WORKFLOW-*.md` files at the project root.

Each row below has two columns: the reference page in this directory, and the user-friendly companion at the project root when one exists.

---

## Getting started

| Reference | Companion |
|-----------|-----------|
| [Introduction](01-introduction.md) — concise spec, glossary, key concepts | [Why PureContext](../WHY-PURECONTEXT.md) — narrative case |
| [Installation](02-installation.md) — prereqs, support matrix, verify, upgrade | [Full Installation Guide](../FULL-INSTALLATION-GUIDE.md) — per-IDE walkthrough |
| [Quick Start](03-quick-start.md) — index a project and search in minutes | [Navigating a New Codebase](../NAVIGATING-NEW-CODE.md) — day-one workflow |

---

## Core reference

- [Configuration](04-configuration.md) — Full `config.json` schema and environment variable overrides
- [CLI Reference](05-cli-reference.md) — Every command and flag (`config --init`, `--health`, `--transport`, etc.)
- [MCP Tools Reference](06-tools-reference.md) — Every tool with inputs, outputs, and examples — grouped by category

---

## Language and framework support

| Reference | Companion |
|-----------|-----------|
| [Language Support](07-language-support.md) — symbol-kind matrix, visibility filters, grammar notes | [Language Support](../LANGUAGE-SUPPORT.md) — narrative tour by category |
| [Framework Adapters](08-framework-adapters.md) — detection rules, extracted kinds, `frameworkMeta` | [Framework Adapters](../FRAMEWORK-ADAPTERS.md) — what each adapter changes in practice |

---

## Core features

- [Dependency Graph Tools](09-dependency-graph.md) — what a symbol depends on, what depends on it, dead-code detection
- [Semantic Search](10-semantic-search.md) — HNSW vector index, embedding providers, hybrid mode
- [Search Quality & Ranking](11-search-quality.md) — FTS5, camelCase splitting, relevance ranking
- [AI Summarization](12-ai-summarization.md) — provider config, batch sizes, cost model
- [Token Savings Tracker](13-token-savings.md) — per-session token (and dollar) accounting

Companion narratives: [Finding Code](../FINDING-CODE.md), [AI Summaries](../AI-SUMMARIES.md), [AST-Level Search](../AST-SEARCH.md), [Code Intelligence](../CODE-INTELLIGENCE.md).

---

## Deployment

| Reference | Companion |
|-----------|-----------|
| [Transport Modes](14-transport-modes.md) — stdio vs HTTP/SSE, TLS via reverse proxy | — |
| [Team Setup & Multi-Tenant](15-team-setup.md) — permissions, rate limit, admin API reference | [Using PureContext with a Team](../TEAM-SETUP.md) — narrative deployment |
| [Docker Deployment](16-docker.md) — image tags, compose, volumes, env vars, healthchecks | — |

---

## Advanced features

| Reference | Companion |
|-----------|-----------|
| [Web UI](17-web-ui.md) — config flags, keyboard shortcuts, URL conventions | [The Web UI](../WEB-UI.md) — when to leave the chat |
| [Git & History Integration](18-git-history.md) — symbol history, churn, diff analysis | [Code History](../CODE-HISTORY.md) — narrative |
| [Cross-Repo Intelligence](19-cross-repo.md) — multi-repo search, similarity, MCP Resources | — |
| [AI-Powered Architecture Analysis](20-architecture-analysis.md) — metrics, anti-patterns, auto-docs | [Code Health](../CODE-HEALTH.md), [Health Dashboards](../HEALTH-DASHBOARDS.md), [Visualizing Code Structure](../VISUALIZING-CODE.md) |
| [Ecosystem & Data Tools](21-ecosystem-tools.md) — dbt, OpenAPI handler, SQL handler, column search | — |
| [Distribution & Platform](22-distribution.md) — export/import, registry, webhooks, GitHub Actions | — |

Companion narratives also relevant here: [Making Changes Safely](../SAFE-CHANGES.md), [Understanding Code Relationships](../UNDERSTANDING-RELATIONSHIPS.md), [Refactoring Safely](../REFACTORING-SAFELY.md).

---

## Operations and stability

- [Performance & Scalability](23-performance.md) — worker thread pool, large-repo tuning, memory
- [Security](24-security.md) — API key model, workspace isolation, path-traversal protections, hardening
- [Troubleshooting](26-troubleshooting.md) — common errors, `--health` output, debug logging
- [Architecture Overview](25-architecture-overview.md) — three-layer design, data flow, SQLite schema
- [API Stability & Changelog](27-api-stability.md) — semver policy, stable vs experimental tools, version history

---

## End-to-end workflows

The user-guide root has narrative walkthroughs for full real-world scenarios:

- [Onboarding to a New Codebase](../WORKFLOW-ONBOARDING.md)
- [Refactoring Legacy Code](../WORKFLOW-REFACTORING.md)
- [Reviewing a Pull Request](../WORKFLOW-PR-REVIEW.md)
- [Running a Tech Debt Sprint](../WORKFLOW-TECH-DEBT.md)

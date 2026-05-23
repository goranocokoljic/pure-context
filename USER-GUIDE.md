# PureContext — User Guide

This guide explains what PureContext does, why it changes the way you work with code, and how to use its features effectively. Each section focuses on a capability area with real examples and concrete workflows.

For parameter-level documentation — every tool input, output, and flag — see the [Reference Manual](docs/README.md).

---

## Start here

- [Why PureContext](WHY-PURECONTEXT.md) — The full case: what actually improves when AI has precise context instead of bulk context, who benefits, and what PureContext does not do

---

## Core capabilities

- [Navigating a New Codebase](NAVIGATING-NEW-CODE.md) — How to orient yourself on day one, find entry points, trace a feature, and build a mental model without reading files at random

- [Finding Code](FINDING-CODE.md) — Three search modes with examples: by name when you know it, by meaning when you don't, and by content when you need grep. Includes tips for when each fails.

- [Making Changes Safely](SAFE-CHANGES.md) — Blast radius analysis before touching anything, context bundles for understanding dependencies, the full pre-change workflow, and architectural violation detection

- [Understanding Code Relationships](UNDERSTANDING-RELATIONSHIPS.md) — Call hierarchies, class hierarchies, interface implementations, circular dependency detection, and coupling maps

- [Refactoring Safely](REFACTORING-SAFELY.md) — Pre-flight checks before renaming, deleting, or moving symbols. Sequenced, risk-annotated refactoring plans for structural changes.

- [Understanding Code History](CODE-HISTORY.md) — Symbol-level git history (not file-level), churn analysis for identifying risk, ownership mapping, and PR analysis before you read a diff

---

## Features worth knowing

- [The Web UI](WEB-UI.md) — When to leave the chat and use the browser: visual dependency graphs, the architecture heatmap, symbol timelines, and what each is actually useful for

- [AI Summaries](AI-SUMMARIES.md) — How symbol descriptions are generated, why they matter for search quality and AI accuracy, what they cost, and when to enable them

- [Code Health & Architecture Analysis](CODE-HEALTH.md) — Quality metrics, anti-pattern detection, auto-generated architecture docs, CI enforcement, and finding refactoring opportunities before they become crises

- [Health Dashboards & Debt Reporting](HEALTH-DASHBOARDS.md) — Five-axis health radar, before/after PR comparisons, and comprehensive debt reports with prioritized action items

- [Visualizing Code Structure](VISUALIZING-CODE.md) — Mermaid and DOT diagrams of import graphs, call graphs, class hierarchies, and dependency matrices. Architecture snapshots for tracking structural change over time.

- [AST-Level Search](AST-SEARCH.md) — Find any tree-sitter node type, search by type signature pattern, find symbols by decorator, and filter by complexity thresholds

- [Code Intelligence](CODE-INTELLIGENCE.md) — Entry points, public API surface, TODO inventory, complexity hotspots, type graphs, untested symbols, and coverage mapping

---

## Language and framework coverage

- [Language Support](LANGUAGE-SUPPORT.md) — All 34 supported languages plus regex-based stylesheet handlers: what's extracted, what's filtered, and known limitations

- [Framework Adapters](FRAMEWORK-ADAPTERS.md) — Routes, components, and ORM entities pulled out as first-class symbols for Vue, React, Nuxt, Next.js, Angular, NestJS, Django, FastAPI, Flask, Spring Boot, Rails, Laravel, Flutter, and more

---

## For teams and enterprise

- [Using PureContext with a Team](TEAM-SETUP.md) — Why a shared server is fundamentally different from local use, how to set it up, how to keep the index current automatically, and what enterprise deployments need to consider

---

## Real-world workflows

Complete end-to-end examples showing how PureContext fits into real development situations:

- [Onboarding to a New Codebase](WORKFLOW-ONBOARDING.md) — First day on a 6,000-file microservices platform: from zero understanding to bug found and fix scoped in 15 minutes

- [Refactoring Legacy Code](WORKFLOW-REFACTORING.md) — Replacing a custom JWT implementation in a 6-year-old Django monolith: discovery, hidden dependencies, migration planning, and verification

- [Reviewing a Pull Request](WORKFLOW-PR-REVIEW.md) — A 40-file authentication migration PR: structured review in 45 minutes that found two real issues before reading most of the diff

- [Running a Tech Debt Sprint](WORKFLOW-TECH-DEBT.md) — Full lifecycle of a two-week debt reduction sprint: assessment, planning, safe execution, and proving the improvement with snapshots

---

## Reference Manual

The [Reference Manual](docs/README.md) covers every tool, configuration option, language, framework adapter, and deployment option in detail. Use it when you need the exact parameter name, the full list of symbol kinds, or the Docker Compose configuration.

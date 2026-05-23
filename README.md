# PureContext MCP

[![npm version](https://img.shields.io/npm/v/purecontext-mcp.svg)](https://www.npmjs.com/package/purecontext-mcp)
[![Stable](https://img.shields.io/badge/stability-stable-brightgreen.svg)](docs/27-api-stability.md)

**Stop burning context tokens reading whole files.** PureContext MCP indexes your codebase and lets AI agents retrieve exactly the code they need — a single function, a class, a route definition — without loading hundreds of irrelevant lines first.

```
Without PureContext:  800-line auth file → ~2,000 tokens to find one function
With PureContext:     45-line function   →   ~150 tokens
                      Savings: 93%
```

But token savings are the mechanism, not the point. The point is that AI gets better answers from precise context than from bulk context. Less hallucination. More accurate suggestions. The ability to work effectively on large codebases that don't fit in any context window.

---

## Quick start

```bash
# 1. Connect to Claude Code (no global install needed)
claude mcp add purecontext-mcp -- npx purecontext-mcp

# 2. Inside your project, install the workflow rules
#    (auto-detects Claude / Cursor / Windsurf / Continue / Cline / Roo Code / VS Code / Claude Desktop)
npx purecontext-mcp install all
```

Then in a Claude Code conversation:

```
Index my project at /path/to/my-project
```

That's it. Claude will index your codebase and you can start navigating it by name, by meaning, or by dependency — without reading files.

---

## Documentation

### User Guide — start here

The guide explains what PureContext does, why each feature exists, and how to use it effectively in real-world situations. It covers both solo developers and team deployments.

| | |
|-|-|
| [Why PureContext](WHY-PURECONTEXT.md) | The full case — beyond token savings |
| [Navigating a New Codebase](NAVIGATING-NEW-CODE.md) | Day one on an unfamiliar project |
| [Finding Code](FINDING-CODE.md) | Three search modes with examples |
| [Making Changes Safely](SAFE-CHANGES.md) | Blast radius and dependency analysis |
| [Understanding Code Relationships](UNDERSTANDING-RELATIONSHIPS.md) | Call hierarchies, cycles, coupling, implementations |
| [Refactoring Safely](REFACTORING-SAFELY.md) | Pre-flight checks before rename, delete, or move |
| [Understanding Code History](CODE-HISTORY.md) | Symbol-level git history and churn |
| [The Web UI](WEB-UI.md) | Visual graph, heatmap, symbol timeline |
| [AI Summaries](AI-SUMMARIES.md) | Better search on undocumented codebases |
| [Code Health & Architecture Analysis](CODE-HEALTH.md) | Quality metrics, anti-patterns, arch docs |
| [Health Dashboards & Debt Reporting](HEALTH-DASHBOARDS.md) | Health radar, debt scores, PR health diffs |
| [Visualizing Code Structure](VISUALIZING-CODE.md) | Mermaid/DOT diagrams, architecture snapshots |
| [AST-Level Search](AST-SEARCH.md) | Node types, signatures, decorators, complexity |
| [Code Intelligence](CODE-INTELLIGENCE.md) | Entry points, public API, TODOs, coverage |
| [Language Support](LANGUAGE-SUPPORT.md) | All 34 supported languages and what's extracted |
| [Framework Adapters](FRAMEWORK-ADAPTERS.md) | Vue, React, Django, Spring, Rails, Flutter, ORMs, and more |
| [Using PureContext with a Team](TEAM-SETUP.md) | Shared server, enterprise setup |

**Real-world workflows:**

| | |
|-|-|
| [Onboarding to a New Codebase](WORKFLOW-ONBOARDING.md) | First day on a 6,000-file microservices platform |
| [Refactoring Legacy Code](WORKFLOW-REFACTORING.md) | Replacing auth in a 6-year-old Django monolith |
| [Reviewing a Pull Request](WORKFLOW-PR-REVIEW.md) | 40-file PR, 45 minutes, two real bugs found |
| [Running a Tech Debt Sprint](WORKFLOW-TECH-DEBT.md) | Two-week debt reduction: assess, plan, execute, measure |

→ [Full guide index](USER-GUIDE.md)

### Reference Manual

Parameter-level documentation for every tool, configuration option, language, framework adapter, and deployment option.

You should start from docs/README.md.

---

## What it indexes

### Languages

**34 languages** via bundled tree-sitter WASM grammars — no separate install required.

| Category | Languages |
|----------|-----------|
| Web / Application | TypeScript, JavaScript, Python, PHP, Ruby, Go, Java, Kotlin, C#, Scala, Dart, Swift, Elixir, Haskell, Lua, R, Perl, Groovy, Erlang, Gleam |
| Systems | C, C++, Rust, Fortran, Objective-C |
| Scripting & Game | Bash, GDScript |
| Infrastructure & Config | Terraform / HCL, Nix |
| Data & API | SQL, Protobuf, GraphQL, OpenAPI / YAML, XML |
| Styling (regex-based) | SCSS, SASS, LESS, CSS |

→ [Language Support guide](LANGUAGE-SUPPORT.md) · [Full reference](docs/07-language-support.md)

### Frameworks

**Framework-aware extraction** — routes, components, hooks, models, ORM entities, and middleware are pulled out as first-class symbols (not just functions and classes).

| Stack | Frameworks |
|-------|-----------|
| JavaScript / TypeScript | Vue 3, React, Nuxt, Next.js (Pages + App Router), Angular, NestJS, Express, Fastify |
| Python | Django, FastAPI, Flask |
| Go | Gin, Echo, Fiber |
| PHP | Laravel, Symfony |
| Ruby | Rails, Sinatra |
| Java | Spring Boot, Micronaut, Quarkus |
| Kotlin | Ktor, Spring (Kotlin) |
| Rust | Axum, Actix-web, Rocket |
| Mobile | Flutter |
| ORMs | Hibernate, SQLAlchemy, Django ORM, Prisma, TypeORM |

→ [Framework Adapters guide](FRAMEWORK-ADAPTERS.md) · [Full reference](docs/08-framework-adapters.md)

---

## Installation

**Requirements:** Node.js 18, 20, or 22. Prebuilt binaries included for Windows, macOS, and Linux — no native compilation needed.

### Claude Code

```bash
claude mcp add purecontext-mcp -- npx purecontext-mcp@latest
```

### Claude Desktop

Edit `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "purecontext": {
      "command": "npx",
      "args": ["purecontext-mcp@latest"]
    }
  }
}
```

### Cursor

Create `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` for global):

```json
{
  "mcpServers": {
    "purecontext": {
      "command": "npx",
      "args": ["purecontext-mcp@latest"]
    }
  }
}
```

### Windsurf

Open Windsurf Settings → MCP section, or edit the MCP config file directly:

```json
{
  "mcpServers": {
    "purecontext": {
      "command": "npx",
      "args": ["purecontext-mcp@latest"]
    }
  }
}
```

### VS Code

Create `.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "purecontext": {
      "type": "stdio",
      "command": "npx",
      "args": ["purecontext-mcp@latest"]
    }
  }
}
```

### Shared team server (HTTP)

If your team runs a shared PureContext server, connect with an HTTP transport instead:

```json
{
  "mcpServers": {
    "purecontext": {
      "transport": "http",
      "url": "https://purecontext.yourcompany.com/mcp/sse",
      "headers": {
        "Authorization": "Bearer pctx_yourpersonalkey"
      }
    }
  }
}
```

→ [Full installation guide](FULL-INSTALLATION-GUIDE.md)

---

## Teaching your AI agent to use PureContext well

Installing PureContext gives your agent the tools. Adding the agent instructions tells it *how* to use them — which tool to pick for each task, in what order, and what to avoid.

Without these instructions, an agent may default to reading entire files rather than using `search_symbols`, or may not know to call `list_repos` first to get the repository ID required by every tool.

### One-command install (recommended)

Run this once inside your project directory:

```bash
npx purecontext-mcp install all
```

This auto-detects which AI coding tools you have set up in the project and writes the PureContext workflow rules to the right place for each. Re-running is safe — every writer is idempotent (managed blocks are marked and replaced rather than appended).

When no `--scope` flag is given, the CLI prompts you to choose where to install:

```
Where should PureContext be installed?
  1) Local  — this project only
  2) Global — all projects (user-level config)
  3) Both
```

Pass `--scope` to skip the prompt:

```bash
npx purecontext-mcp install all --scope=local    # this project only
npx purecontext-mcp install all --scope=global   # user-level, all projects
npx purecontext-mcp install all --scope=both     # both places at once
```

For a single tool:

```bash
npx purecontext-mcp install <tool> --scope=global
```

To preview without writing files:

```bash
npx purecontext-mcp install all --dry-run
npx purecontext-mcp install --list      # show which IDEs were detected
```

Supported tools and where each one writes:

| Tool | Local | Global |
|------|-------|--------|
| `claude` | `CLAUDE.md` in project | `~/.claude/CLAUDE.md` + hooks |
| `cursor` | `.cursor/rules/purecontext.mdc` | `~/.cursor/rules/purecontext.mdc` |
| `windsurf` | `.windsurfrules` | `~/.windsurfrules` |
| `continue` | `.continue/config.json` | `~/.continue/config.json` |
| `cline` | `.clinerules` | local only |
| `roo-code` | `.roo/rules-code.md` | local only |
| `vscode` | `.github/copilot-instructions.md` | local only |
| `claude-desktop` | always global | always global |

### Manual install

If you'd rather paste the rules yourself, two instruction files are at the repository root:

- **`AGENT_INSTRUCTIONS_SHORT.md`** — ~2 KB. Mandatory workflow, tool selection table, core rules.
- **`AGENT_INSTRUCTIONS.md`** — ~15 KB. Adds parameter notes, decision trees, anti-patterns.

Paste the contents into whatever system prompt, memory, or rules configuration your agent uses.

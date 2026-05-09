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
# Connect to Claude Code (no global install needed)
claude mcp add purecontext-mcp -- npx purecontext-mcp
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
| [Understanding Code History](CODE-HISTORY.md) | Symbol-level git history and churn |
| [The Web UI](WEB-UI.md) | Visual graph, heatmap, symbol timeline |
| [AI Summaries](AI-SUMMARIES.md) | Better search on undocumented codebases |
| [Code Health & Architecture Analysis](CODE-HEALTH.md) | Quality metrics, anti-patterns, arch docs |
| [Using PureContext with a Team](TEAM-SETUP.md) | Shared server, enterprise setup |

**Real-world workflows:**

| | |
|-|-|
| [Onboarding to a New Codebase](WORKFLOW-ONBOARDING.md) | First day on a 6,000-file microservices platform |
| [Refactoring Legacy Code](WORKFLOW-REFACTORING.md) | Replacing auth in a 6-year-old Django monolith |
| [Reviewing a Pull Request](WORKFLOW-PR-REVIEW.md) | 40-file PR, 45 minutes, two real bugs found |

→ [Full guide index](USER-GUIDE.md)

### Reference Manual

Parameter-level documentation for every tool, configuration option, language, framework adapter, and deployment option.

You should start from docs/README.md.

---

## What it indexes

**34 languages** including TypeScript, JavaScript, Python, Go, Rust, Java, C#, PHP, Ruby, Kotlin, Swift, Dart, C, C++, Elixir, Haskell, Scala, R, Bash, Terraform, Protobuf, GraphQL, SQL, and more.

**Framework-aware extraction** for Vue, React, Nuxt, Next.js, Angular, NestJS, Express, Fastify, Django, FastAPI, Flask, Gin, Rails, Laravel, Spring Boot, and more. Routes, components, hooks, models, and middleware are extracted as first-class symbols.

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

Two instruction files are provided at the repository root:

**`AGENT_INSTRUCTIONS_SHORT.md`** — ~2 KB. The mandatory workflow, tool selection table, core rules, and common patterns. Use this for agents with limited system prompt space.

**`AGENT_INSTRUCTIONS.md`** — ~15 KB. Adds detailed parameter notes, every usage pattern, decision trees, and anti-patterns. Use this for complex multi-step workflows.

**Claude Code** — add to your project's `CLAUDE.md`:

```bash
cat AGENT_INSTRUCTIONS_SHORT.md >> CLAUDE.md
```

**Cursor** — paste into `.cursorrules` or via Cursor Settings → Rules.

**Windsurf** — paste into your workspace memory or rules configuration.

**Any other agent** — paste into whatever system prompt or memory configuration it supports.

Without these instructions, an agent may default to reading entire files rather than using `search_symbols`, or may not know to call `list_repos` first to get the repository ID required by every tool.

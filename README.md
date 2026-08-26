# PureContext MCP

[![npm version](https://img.shields.io/npm/v/purecontext-mcp.svg)](https://www.npmjs.com/package/purecontext-mcp)
[![Stable](https://img.shields.io/badge/stability-stable-brightgreen.svg)](docs/27-api-stability.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Most tools help an AI agent *read* your codebase. PureContext helps it *change* your codebase safely.**

Agents are already good at finding code. What they can't see is the part that breaks things: what a symbol connects to, what quietly changes alongside it, and whether it's risky to touch at all. PureContext MCP indexes your codebase into a structured, queryable model and gives agents that missing layer — **impact, coupling, and change-risk intelligence, before the edit.**

```
Before changing processRefund(), the agent checks:

  get_symbol_risk   → band: HIGH — 47 dependents · churn 8/90d
                      · no direct test · co-changes with ledger.ts (conf 0.71)
  get_blast_radius  → 23 files affected across 4 modules
  get_co_change     → usually moves together with refund.test.ts and ledger.ts

→ so it updates those together, instead of shipping a half-change that
  passes locally and breaks billing in production.
```

This is the layer autonomous agents are missing. Refactoring and change-safety tooling is still mostly built for humans clicking through an IDE — not for an agent about to edit code it has never seen. PureContext closes that gap: blast radius, temporal co-change, rename/delete/move safety checks, and a composite per-symbol risk score — all queryable as MCP tools.

It's built on **token-efficient retrieval** as the foundation: agents pull a single function, class, or route by name or meaning instead of reading whole files — typically **90%+ fewer context tokens** ([see it in action](#what-this-looks-like-in-practice)). Precise context means less hallucination, more accurate edits, and the ability to work on codebases far larger than any context window.

---

## Quick start

```bash
# Inside your project: registers the MCP server (pinned to your global Node) AND
# adds the workflow rules — auto-detects Claude / Cursor / Windsurf / Continue /
# Cline / Roo Code / Copilot / Claude Desktop
npx purecontext-mcp@latest install all

# Prefer to wire up Claude Code by hand? Register the server manually:
claude mcp add purecontext-mcp -- npx purecontext-mcp@latest
```

Then in a Claude Code conversation:

```
Index my project at /path/to/my-project
```

That's it. Claude will index your codebase and you can start navigating it by name, by meaning, or by dependency — without reading files.

---

## What this looks like in practice

### First, find and understand it

A typical "find and understand" conversation, before vs. after:

**Without PureContext**

```
You:    Where do we handle Stripe webhook signature verification?
Claude: I'll search the codebase.
        [reads src/api/webhooks/stripe.ts — 412 lines, ~3,100 tokens]
        [reads src/lib/stripe-client.ts    — 287 lines, ~2,150 tokens]
        [reads src/middleware/webhook.ts   — 198 lines, ~1,490 tokens]
        Verification happens in verifyStripeSignature() at line 87 of stripe.ts.
        Total context used: ~6,740 tokens
```

**With PureContext**

```
You:    Where do we handle Stripe webhook signature verification?
Claude: search_symbols(query: "stripe webhook signature")
        → 3 matches, 78 tokens
        get_symbol_source(symbolId: "verifyStripeSignature")
        → 32 lines, 180 tokens
        verifyStripeSignature() at src/api/webhooks/stripe.ts:87.
        It uses the timing-safe HMAC check from Stripe's SDK with a 5-minute tolerance.
        Total context used: ~258 tokens — 96% less
```

The agent stays in the conversation instead of running out of context after one file read — which frees it to get to the part that actually matters: changing the code safely.

### Then change it without breaking things

A typical "modify this" conversation, before vs. after:

**Without PureContext**

```
You:    Add a partial-refund path to processRefund().
Claude: [reads processRefund, edits it]
        Done — added the partial-refund branch.

        (Never saw that ledger.ts reconciles every refund, or that
         refund.test.ts asserts the old totals. CI breaks; billing
         drifts in production.)
```

**With PureContext**

```
You:    Add a partial-refund path to processRefund().
Claude: get_symbol_risk(symbolId: "processRefund")
        → band: HIGH — 47 dependents · churn 8/90d · no direct test
          · co-changes with ledger.ts (conf 0.71)
        get_blast_radius(symbolId: "processRefund")
        → 23 files affected across 4 modules
        get_co_change(symbolId: "processRefund")
        → usually moves together with ledger.ts and refund.test.ts

        This symbol is high-risk and untested. I'll update processRefund(),
        adjust the reconciliation in ledger.ts, and extend refund.test.ts
        in the same change.
```

The difference here isn't tokens — it's that the agent saw the second-order edits *before* writing code, instead of discovering them in a failed CI run or a production incident.

---

## Change & refactoring intelligence

This is the part most code tools leave to humans. PureContext exposes it as MCP tools an agent can call *before* it edits — so autonomous changes come with the same impact awareness a careful senior engineer would bring.

| Question the agent can answer | Tool |
|---|---|
| What breaks if I change this symbol? | `get_blast_radius` |
| What files historically change *together* with this one (but don't import it)? | `get_co_change` |
| How risky is this symbol to change, and why? | `get_symbol_risk` |
| Is it safe to rename / delete / move this? | `check_rename_safe` · `check_delete_safe` · `check_move_safe` |
| What's the impact *before* I edit, and what will I forget to touch? | `prepare_change` |
| Did my applied change actually cover everything I planned? | `verify_change` |
| Did my change introduce a new cycle or layer violation? | `compare_change_impact` |
| What's the sequenced, risk-annotated plan for a larger refactor? | `plan_refactoring` |
| Who calls this, and who do they call? | `get_call_hierarchy` · `find_references` |
| What's churning or accumulating debt? | `get_churn_metrics` · `get_debt_report` · `health_radar` |

**`get_symbol_risk`** is the composite verdict: it fuses change frequency (churn), centrality (how much depends on it), complexity, test-coverage gaps, and temporal co-change into one banded score (`low` / `review` / `high`) with human-readable reasons — never a black-box number, and deliberately **code-centered** (no author or productivity metrics). **`get_co_change`** surfaces the coupling the import graph can't see — the test, the migration, or the feature flag that always moves with a file. Together they let an agent edit unfamiliar code the way a cautious human does: check the blast radius, update what moves with it, and flag what it shouldn't touch alone.

PureContext also closes the loop *around* an edit — **judgment, not actuation** (it never writes files; your agent does): **`prepare_change`** gives a pre-edit impact verdict for a stated intent (and flags the co-change partners you're about to forget), **`verify_change`** reconciles the real diff against that plan (`complete` / `incomplete` / `scope_expanded`), and **`compare_change_impact`** reports the *new* cycles or layer violations a change introduced — never blaming it for pre-existing ones.

→ Full tool list and parameters: [AGENT_REFERENCE.md](AGENT_REFERENCE.md) · safe-change workflow: [SAFE-CHANGES.md](SAFE-CHANGES.md)

---

## Measured search precision

PureContext is benchmarked on **87 real-world open-source projects** with 25 curated ground-truth queries each. Top-rank precision (P@1) reaches 84% on NestJS, 84% on Terraform, 72% on Protobuf and GraphQL, 60% on Nix, 52% on LÖVE (Lua/C++), and 40% on Tokio (Rust). Full per-language tables, methodology, and reproduction steps are in [BENCHMARKS.md](BENCHMARKS.md).

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

Parameter-level documentation for every tool, configuration option, language, framework adapter, and deployment option lives in [`docs/README.md`](docs/README.md). The reference manual is cross-linked with the user guide above — every topic has both a narrative and a reference page where one helps.

---

## What it indexes

### Languages

**34 languages** via bundled tree-sitter WASM grammars — no separate install required.

Symbol indexing and search cover all 34. Dependency **edges** (blast radius, importers, cycles) currently cover TypeScript/JavaScript, the JVM family (Kotlin, Java, Scala, Groovy — package-aware, multi-module safe), C# (namespace-aware, multi-project safe), Python (layout-convention resolver, `src/` layouts and relative imports), Go (`go.mod` resolver, workspaces supported), and languages whose imports are file paths — see [which languages get dependency edges](LANGUAGE-SUPPORT.md#which-languages-get-dependency-edges) before relying on the graph tools for PHP or Rust codebases.

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
npx purecontext-mcp@latest install all
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
npx purecontext-mcp@latest install all --scope=local    # this project only
npx purecontext-mcp@latest install all --scope=global   # user-level, all projects
npx purecontext-mcp@latest install all --scope=both     # both places at once
```

For a single tool:

```bash
npx purecontext-mcp@latest install <tool> --scope=global
```

To preview without writing files:

```bash
npx purecontext-mcp@latest install all --dry-run
npx purecontext-mcp@latest install --list      # show which IDEs were detected
```

Supported tools and where each one writes its workflow rules (it also registers the `purecontext-mcp` MCP server with each — pinned to your global Node — in that tool's own MCP config):

| Tool | Local | Global |
|------|-------|--------|
| `claude` | `CLAUDE.md` in project | `~/.claude/CLAUDE.md` + hooks |
| `cursor` | `.cursor/rules/purecontext.mdc` | `~/.cursor/rules/purecontext.mdc` |
| `windsurf` | `.windsurf/rules/purecontext.md` | `~/.windsurf/rules/purecontext.md` |
| `continue` | `.continue/config.json` | `~/.continue/config.json` |
| `cline` | `.clinerules` | local only |
| `roo-code` | `.roo/rules-code.md` | local only |
| `copilot` | `.github/copilot-instructions.md` | local only |
| `claude-desktop` | always global | always global |

### Manual install

If you'd rather paste the rules yourself, two instruction files are at the repository root:

- **[`AGENT_INSTRUCTIONS.md`](AGENT_INSTRUCTIONS.md)** — the onboarding doc: mandatory workflow, tool-selection table, navigation patterns, and anti-patterns. Paste into your agent's rules file, or run `npx purecontext-mcp install <tool>` to write a compact, always-on version automatically.
- **[`AGENT_REFERENCE.md`](AGENT_REFERENCE.md)** — the single canonical reference: a full intent→tool picker, every parameter, every navigation pattern, and known limitations. Installed automatically by `hooks --install`; read this when an agent needs the authoritative answer.

Paste the contents into whatever system prompt, memory, or rules configuration your agent uses.

---

## License

MIT — see [LICENSE](LICENSE).

## Contributing

Issues and pull requests are welcome at [github.com/goranocokoljic/pure-context](https://github.com/goranocokoljic/pure-context). Before opening a feature PR, please open an issue to discuss the design — the three-layer architecture (Core → Handlers → Adapters) has hard rules about dependency direction that are easy to violate accidentally. See [`CLAUDE.md`](CLAUDE.md) at the project root for the architectural conventions.

For language or framework adapters: pick a real-world repository, add a 25-query ground-truth file in `benchmarks/<project>/queries.json`, and include benchmark numbers (P@1 / P@3 / R@5) in the PR description so reviewers can confirm the change is a net improvement.

## Support

- **Bug reports and feature requests:** [GitHub Issues](https://github.com/goranocokoljic/pure-context/issues)
- **Questions about MCP integration:** Open a Discussion on the repository
- **Changelog:** [CHANGELOG.md](CHANGELOG.md)
- **Stability and semver policy:** [docs/27-api-stability.md](docs/27-api-stability.md)

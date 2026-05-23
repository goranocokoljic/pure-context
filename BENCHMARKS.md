# Benchmarks

PureContext is benchmarked on **87 real-world open-source projects** spanning 29 language groups. This page reports measured search precision so you can decide whether PureContext fits your stack before installing.

The benchmarks are reproducible — every project, query set, and result file lives in the `benchmarks/` directory of the source repository.

---

## Methodology

For each project:

1. **Index it** with PureContext.
2. **Run 25 ground-truth queries** drawn from real symbol names and natural-language descriptions of what each symbol does. Ground-truth answers are the curated "correct" symbols a developer would expect.
3. **Score three metrics:**
   - **P@1** (Precision at rank 1): the correct symbol is the top result.
   - **P@3** (Precision at rank 3): the correct symbol is in the top 3.
   - **R@5** (Recall at top 5): the correct symbol appears anywhere in the top 5.

P@1 is the most demanding metric — it measures how often the *first* answer is the right one without the agent having to scroll through alternatives. P@3 and R@5 reflect what an agent actually consumes in a real session.

Ground-truth query sets are intentionally curated by hand (`benchmarks/<project>/queries.json`), not auto-generated, and can be inspected or extended.

---

## Per-language averages

Group averages over all benchmarked projects in each language.

| Language group | Projects | P@1 | P@3 | R@5 |
|----------------|---------:|----:|----:|----:|
| GraphQL | 3 | **65%** | 81% | 87% |
| Nix | 2 | **60%** | 74% | 76% |
| GDScript | 2 | **58%** | 78% | 88% |
| Terraform / HCL | 2 | **53%** | 64% | 67% |
| Protobuf | 3 | **51%** | 51% | 60% |
| TypeScript / JavaScript | 4 | **44%** | 57% | 61% |
| Lua | 2 | **36%** | 56% | 64% |
| PHP | 2 | **36%** | 54% | 58% |
| Python | 2 | **34%** | 46% | 56% |
| Rust | 2 | **34%** | 50% | 60% |
| OpenAPI / YAML | 3 | **31%** | 32% | 36% |
| Kotlin | 2 | **30%** | 36% | 40% |
| Go | 1 | **28%** | 56% | 76% |
| Java | 1 | **24%** | 32% | 44% |
| SQL | 3 | **23%** | 44% | 52% |
| C / C++ | 6 | **13%** | 22% | 30% |
| Scala | 2 | 12% | 20% | 32% |
| Swift | 3 | 11% | 19% | 23% |
| Ruby | 4 | 10% | 16% | 20% |
| C# / .NET | 2 | 10% | 16% | 18% |
| Dart / Flutter | 2 | 8% | 14% | 18% |
| Objective-C | 3 | 5% | 11% | 16% |
| Haskell | 2 | 0% | 16% | 22% |

Numbers are averages across the projects in each row. Bold P@1 values mark groups where PureContext consistently produces the right answer at rank 1 on a non-trivial fraction of queries.

---

## Per-project highlights

Selected projects from the full set of 87 — full results in `benchmarks/<project>/results/purecontext.json`.

| Project | Language / framework | P@1 | P@3 | R@5 | Symbols indexed |
|---------|----------------------|----:|----:|----:|----------------:|
| nestjs-ecommerce-api | TypeScript / NestJS | 84% | 100% | 100% | 3,314 |
| terraform-aws-eks | Terraform / HCL | 84% | 92% | 96% | 1,589 |
| dialogic | GDScript | 84% | 100% | 100% | 3,025 |
| grpc-proto | Protobuf | 72% | 80% | 92% | 260 |
| saleor | GraphQL / Python | 72% | 88% | 96% | 27,719 |
| graphql-code-generator | TypeScript / GraphQL | 72% | 84% | 84% | 3,602 |
| terraform-aws-components | Terraform / HCL | 68% | 80% | 84% | 14,914 |
| kubernetes-openapi | OpenAPI / YAML | 64% | 68% | 80% | 4,739 |
| eu-za-tebe | PHP / CodeIgniter | 60% | 72% | 72% | 5,575 |
| envoy | Protobuf / C++ | 60% | 60% | 68% | 44,739 |
| home-manager | Nix | 60% | 72% | 76% | 9,023 |
| flake-utils | Nix | 60% | 76% | 76% | 50 |
| kurirfe | JavaScript / Nuxt | 56% | 60% | 64% | 382 |
| love | C++ / Lua | 52% | 80% | 88% | 26,165 |
| graphql-engine | GraphQL / Rust / Haskell | 52% | 72% | 80% | 40,417 |
| maven | XML / Java | 48% | 52% | 56% | 15,284 |
| jaffle-shop | SQL / dbt | 44% | 80% | 84% | 54 |
| ecrad | Fortran | 44% | 60% | 64% | 684 |
| ktor | Kotlin | 44% | 48% | 52% | 11,974 |
| tokio | Rust | 40% | 60% | 72% | 2,799 |
| phoenix | Elixir / Phoenix | 36% | 64% | 76% | 1,317 |
| neovim | Lua / C | 36% | 68% | 80% | 9,514 |
| kong | Lua / Kong | 36% | 52% | 56% | 4,210 |
| sqitch | Perl | 36% | 60% | 72% | 1,143 |
| rabbitmq-server | Erlang | 36% | 48% | 52% | 32,585 |
| angular-realworld | Angular / TypeScript | 36% | 68% | 72% | 127 |
| jhipster-sample-app | Angular / TypeScript | 32% | 36% | 48% | 1,302 |
| godot-demo-projects | GDScript | 32% | 56% | 76% | 3,274 |
| stripe-openapi | OpenAPI / YAML | 28% | 28% | 28% | 43,078 |
| listmonk | Go | 28% | 56% | 76% | 966 |
| serde | Rust | 28% | 40% | 48% | 293 |
| emqx | Erlang | 28% | 32% | 36% | 43,147 |
| infisical | React / TypeScript | 8% | 28% | 36% | 27,295 |

The TypeScript/NestJS result (84% P@1, 100% P@3) is the strongest single-project number — NestJS routes and providers map cleanly to the decorator-based extraction in PureContext's framework adapter.

---

## Where PureContext wins clearly

**Framework-aware extraction.** Adapters for NestJS, Terraform, Protobuf, GraphQL, and dbt-style SQL pull domain symbols (routes, resources, services, schemas, models) out as first-class entries rather than relying on generic function/class extraction. This is where the highest P@1 numbers come from.

**Cross-language identifier aliases.** Neovim's C API (`nvim_open_win`) is called from Lua as `vim.api.nvim_open_win`. PureContext stores the Lua alias as an FTS token so semantic queries find the C implementation (36% P@1 on neovim).

**Handler depth where it matters.** Ruby DSL macros (`has_many`, `belongs_to`, `before_action`), Rust impl methods stored as bare names with identity-exact ranking, Erlang functions stored without arity suffix, and ObjC selectors built as `setObject:forKey:` — each lift dynamic-language search precision substantially.

**IaC and schema languages.** Terraform/HCL extraction (resources, modules, variables, outputs) and OpenAPI handler with hyphen-aware regex give PureContext competitive numbers on infrastructure repos that traditional code-search tools miss.

## Where PureContext currently scores low

These are honest gaps, tracked as P1 work:

- **Swift (11% P@1).** Generic type parameters are stripped and protocol types lack semantic summaries. Concept-based queries like *"protocol that describes how application state evolves"* fail to match `Reducer<State, Action>`.
- **Scala (12% P@1).** Heavily generic types (`ZIO[R, E, A]`, `ZLayer[RIn, E, ROut]`) have no FTS overlap with their semantic descriptions; `given`/`using` instances are not extracted.
- **Haskell (0% P@1, 16% P@3).** Record types and functions have no docstrings by default; FTS content is name-tokens only. Symbols enter the top-5 (R@5 = 22%) but never rank first.
- **Objective-C (5% P@1).** The handler was strengthened in 1.5.0 (full `@interface`/`@protocol` extraction and selector building) — numbers will rise on the next benchmark cycle.
- **Large monorepos with abstract type queries (flutter SDK, novu).** Queries like *"abstract widget that owns mutable state"* don't tokenize against `StatefulWidget` without semantic embeddings on top. Improving this requires summary enrichment, not ranker tweaks.

---

## Token efficiency

PureContext achieves near-100% token reduction versus the naive "read every source file" baseline on every benchmarked project. Token savings are not the main differentiator — what matters is **whether the returned symbols are correct**, which is what the P@1 / P@3 / R@5 numbers above measure.

---

## Reproducing the benchmark

```bash
git clone https://github.com/goranocokoljic/pure-context
cd pure-context
npm install
npm run build
npm run benchmark -- --project nestjs-ecommerce-api
```

Results are written to `benchmarks/<project>/results/purecontext.json`. Ground-truth query sets live in `benchmarks/<project>/queries.json` and can be inspected, extended, or replaced.

---

## Limitations of these numbers

- **25 queries per project is a small sample.** Group averages over multiple projects are more reliable than any single project's score.
- **Ground-truth queries are biased toward what humans ask AI agents** — symbol lookups by name and short natural-language descriptions. They do not measure agent-driven graph traversal (`get_blast_radius`, `get_call_hierarchy`, etc.), which is where most of the real value in an MCP server shows up in production agent loops.
- **Numbers reflect PureContext 1.5.0 (May 2026).** Each release shifts results — re-run the benchmark before making decisions on stale data.
- **Project mix is convenience-sampled.** Projects were selected to cover language and framework breadth, not weighted by GitHub popularity or download counts. Some categories (Web/TypeScript, IaC) are deliberately over-represented; mobile and embedded categories are under-represented.

The full per-project breakdown including symbol counts, indexing speeds, and language-group narratives is generated from the same benchmark runs and lives in the `dev-docs/benchmarks/` directory of the source repository (gitignored from npm releases).

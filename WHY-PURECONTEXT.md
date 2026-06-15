# Why PureContext

## The problem is not tokens. It's accuracy.

When an AI agent works with your code, the quality of its answers depends entirely on what you put in front of it. Give it an entire 800-line file to find one function and two things happen: you burn thousands of tokens getting there, and the AI spends most of that context on code that has nothing to do with your question.

Token savings are the measurable side effect of a more fundamental improvement: **AI gets better answers from precise context than from bulk context.**

A 45-line function retrieved by name gives Claude exactly what it needs. An 800-line file gives Claude the function plus seven unrelated utilities, three deprecated helpers, a wall of imports, and a pile of comments about things that were fixed in 2019. All of that crowds out the signal.

PureContext fixes this by giving AI agents a way to navigate code the way experienced engineers do — by name, by meaning, by dependency — rather than by reading everything and hoping.

That precise retrieval is the **foundation**. It's also where the bigger shift begins.

---

## The bigger problem: agents can read code, but not change it safely

Finding code is the easy half — and increasingly, every agent harness can do it. The hard half is *changing* code you didn't write: knowing what depends on a function, what quietly moves alongside it, and whether it's safe to touch at all.

That's the context a careful senior engineer carries in their head and a fresh agent simply doesn't have. PureContext gives the agent that context as tools it can call **before** it edits:

- **Blast radius** (`get_blast_radius`) — every file that transitively depends on a symbol, so a change is never blind.
- **Temporal co-change** (`get_co_change`) — the files that historically move *together* in commits but don't import each other: the test, the migration, the feature flag. The coupling the dependency graph can't see.
- **Composite change risk** (`get_symbol_risk`) — one banded `low` / `review` / `high` verdict fusing churn, centrality, complexity, test gaps, and co-change, with plain-English reasons. Deliberately code-centered: no author or productivity metrics.
- **Refactor-safety checks** (`check_rename_safe` / `check_delete_safe` / `check_move_safe`, `plan_refactoring`) — a pre-flight verdict before a rename, delete, move, or multi-step refactor.

This is what sets PureContext apart from a fast symbol index: it doesn't just help an agent *find* code, it helps it *change* code without breaking what it can't see. The token-efficient retrieval underneath is what makes every one of those checks cheap enough to run on every edit.

---

## A closed loop, not just a warning

The checks above are the *before*. PureContext closes the loop around the whole edit:

1. **`prepare_change`** — before editing, state your intent (rename, delete, modify, extract) and a target. PureContext resolves the exact change set and returns one pre-flight verdict: the files you'll touch, the composite risk, the historically co-changing files you're *about to forget*, the tests to run, and any architectural flags — in plain English, with reasons, not a bare confidence number. If the target is ambiguous it tells you and asks; it never guesses.
2. **You make the edit.** PureContext does not. Your agent already has a file-write tool; PureContext's job is judgment, not a second pair of hands.
3. **`verify_change`** — after editing, hand back the real diff. PureContext reconciles what you *did* against what it *predicted*: which co-change partners you addressed, which you still haven't, what you changed that wasn't planned, and whether any changed code is still untested. "Complete," "incomplete," or "scope expanded" — with the reasons.
4. **`compare_change_impact`** — snapshot the architecture before, and afterwards PureContext reports only what your change *introduced*: a new import cycle, a new layer violation. It never blames you for problems that were already there.

That before → edit → verify → compare loop is the difference between a tool that *flags* risk and one that confirms the change was actually safe and complete.

---

## What changes in practice

### Your AI assistant gets fewer hallucinations

Hallucinations in coding tasks most often happen when the AI is working from incomplete or outdated context. If Claude has to read a file from two weeks ago that you haven't reindexed, or guess at function signatures from imports rather than seeing the actual definition, it will make things up convincingly.

PureContext indexes your codebase on demand and re-indexes incrementally as you work. When Claude asks for `validatePaymentMethod`, it gets the current definition — not a guess, not a stale version, the actual code as it exists right now.

### You stop copy-pasting code into the chat

Without PureContext, a typical conversation goes:

> "I need help understanding how the order processing pipeline works."
> *[You open five files, copy the relevant parts, paste them into the chat]*
> "Here's the OrderProcessor class, here's the CartValidator, here's..."

With PureContext, Claude navigates the codebase itself. You describe what you want to understand and Claude fetches the relevant symbols, follows the dependency chain, and builds its own picture. You stay in the conversation; you're not the file fetcher.

### Large codebases become navigable

A solo developer working on a 500-file TypeScript monorepo, and an enterprise team working on a 40,000-file Java platform, face the same structural problem: the codebase is too large to hold in any context window. PureContext makes both tractable by turning "read these files" into "retrieve these symbols."

The difference matters most in enterprise environments where no single person knows the whole codebase, onboarding takes months, and getting AI to help requires giving it enough context to be useful without hitting token limits.

### AI agents can change code safely, not just read it

Before PureContext, asking an AI to change a core function was a gamble — it didn't know what depended on the code, what moved with it, or whether it was risky to touch.

Now Claude checks the blast radius, the historical co-changers, and a composite risk score *before* editing, and can tell you: *"this is high-risk and untested — it affects 14 files across 3 services and usually moves with `ledger.ts` and `refund.test.ts`, so I'll update those in the same change."* That's the difference between AI assistance and AI guesswork.

---

## Who this is for

**Solo developers** get a faster inner loop. Index your project once, then navigate it with natural language instead of file browsing. The AI remembers the structure so you don't have to keep re-explaining it in every conversation.

**Teams** get a shared understanding of the codebase. When one developer indexes the repository on a shared server, everyone on the team can search it. New developers get a pre-built picture of the codebase on day one. Senior engineers don't spend their week explaining architecture.

**Enterprise environments** get the audit trails, access controls, rate limiting, and Docker-based deployment that make AI-assisted development compatible with security requirements. PureContext doesn't read your code and send it to a third party — it indexes locally and serves over your own network.

---

## What PureContext is not

It is not a replacement for reading code. There will always be times when you need to read a file carefully, understand edge cases, or review logic line by line. PureContext makes those moments targeted — you know which file, which function, which 45 lines matter — instead of exploratory.

It is not a code editor or language server. It does not type-check, lint, or autocomplete. Those tools solve different problems. **It is not a second editor — it never applies your changes for you.** It tells the agent what's safe and what's still missing; the agent does the writing. Judgment, not actuation.

It is not magic. The quality of its output depends on the quality of your codebase structure, documentation, and naming. Well-named functions with docstrings are searchable from the first index. Undocumented spaghetti becomes searchable with AI summarization enabled — but meaningful naming still wins.

---

## The compounding effect

The value of PureContext grows with use. The index improves as your codebase improves. The dependency graph becomes more useful as you add more framework adapters. Git history integration becomes richer as the project ages. AI summaries mean that even undocumented code becomes discoverable.

On a fresh solo project: **useful from day one** for navigation and symbol retrieval.

On a two-year-old enterprise codebase: **transformative** — because that's where the navigation problem is most acute and where accurate AI assistance has the most value.

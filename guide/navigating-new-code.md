# Navigating a New Codebase

Whether you've just joined a team or picked up a project you haven't touched in six months, the first challenge is the same: you don't know where anything is. PureContext gives you a structured way to orient yourself without reading files at random.

---

## The orientation problem

Most developers starting on a new codebase do one of three things: they ask someone to walk them through it (expensive for the team), they read files top-to-bottom hoping to find patterns (slow), or they wait until they need to touch something and learn as they go (risky).

AI assistants make this better in theory — but without a structured index, they can only help you understand files you explicitly show them. PureContext lets Claude navigate the codebase proactively, building a picture you can interrogate.

---

## Step 1: Get the lay of the land

Start by asking Claude to describe the project structure:

> "Give me an overview of this project's structure. What are the main directories and what do they contain?"

Claude will call `get_file_tree` and `get_repo_outline` to return a directory breakdown and the top-level symbols per file — without reading any file content. In a 200-file TypeScript project, this might return something like:

```
src/
  api/          — 12 files, 87 symbols (routes, controllers, middleware)
  core/         — 8 files, 64 symbols (services, domain logic)
  db/           — 5 files, 43 symbols (models, migrations, queries)
  workers/      — 3 files, 28 symbols (background job handlers)
  utils/        — 6 files, 51 symbols (formatters, validators, helpers)
```

That's the skeleton. You now know where things live without reading a single file.

---

## Step 2: Find the entry points

> "Where does this application start? What are the main entry points?"

Claude will search for common patterns — `main`, `createServer`, `app.listen`, `bootstrap` — and return the symbols with their signatures. For a Node.js API:

```
src/index.ts        — bootstrap()           starts the HTTP server
src/api/router.ts   — createRouter()        registers all routes
src/workers/index.ts — startWorkers()       initializes background jobs
```

Three entry points, their file locations, their signatures — in seconds.

---

## Step 3: Follow a feature you care about

Once you know the structure, pick a feature area you'll be working in and trace it:

> "I'll be working on the payment system. Find all payment-related symbols."

```
search_symbols(query: "payment") →
  processPayment()      src/core/billing.ts       function
  PaymentGateway        src/api/gateway.ts         class
  validatePaymentMethod src/core/validators.ts      function
  POST /payments        src/api/routes/payments.ts  route
  PaymentRecord         src/db/models/payment.ts    class (ORM model)
```

Five symbols across five files gives you the full map of the payment system before you've opened a single file.

---

## Step 4: Understand a specific symbol in depth

Now pick the one that matters most:

> "Show me how processPayment works and what it depends on."

Claude calls `get_context_bundle` starting from `processPayment`. It returns the function's source plus everything it imports transitively — `validatePaymentMethod`, `PaymentGateway`, the database model — up to the depth you specify. The token estimate tells you how large the context is before it loads.

This is the difference between "read billing.ts" (entire file) and "get the context bundle for processPayment" (exactly the symbols involved in payment processing, nothing else).

---

## Step 5: Ask questions about what you've found

With the context bundle loaded, ask anything:

> "What happens if the payment gateway is unavailable? Does this code handle that case?"

> "Where does the currency conversion happen? I don't see it in processPayment."

> "Who calls this function? I want to make sure I understand all the places payments are triggered."

Claude uses `find_importers` and `search_symbols` to answer the last question without you having to search manually.

---

## For enterprise onboarding: going deeper

On a large codebase, you won't understand everything in one session. Use PureContext to build a map over time:

**Day 1:** Project structure, entry points, the one domain area you'll be working in.

**Day 2:** The APIs your domain area calls. The services it depends on. The database tables it touches.

**Week 1:** The patterns the codebase uses. How errors propagate. How authentication works. How jobs are scheduled.

Each of these is a focused PureContext session — specific questions with targeted symbol retrieval. You're not reading documentation that may be stale. You're reading the code that's actually running.

---

## Tips

**Use `get_file_outline` on files you'll be editing frequently.** It gives you a complete list of everything defined in a file with signatures and summaries — a live table of contents that's always current.

**Ask about naming conventions early.** `search_symbols(query: "user")` in a new codebase tells you immediately whether the team calls things `User`, `UserRecord`, `UserEntity`, or `Account`. Understanding the vocabulary saves hours.

**Don't try to understand everything at once.** The goal of day-one orientation is to know where to find things, not to understand every file. Let the index do the navigation for you when you need something specific.

---

→ Reference: [MCP Tools Reference](../docs/06-tools-reference.md) — `get_file_tree`, `get_repo_outline`, `get_file_outline`, `search_symbols`, `get_context_bundle`

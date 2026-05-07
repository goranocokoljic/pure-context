# Workflow: Onboarding to a New Codebase

**Scenario:** You've just joined a fintech startup. The codebase is a Node.js/TypeScript monorepo with eight microservices — payments, accounts, notifications, reporting, identity, audit, gateway, and shared-lib. Total: ~6,000 files, ~80,000 symbols. Your first task is to fix a bug in the payment processing flow. You don't know the codebase at all.

Your tech lead has indexed the shared PureContext server and given you an API key. This is your first day.

---

## The session

**You:** "I'm new to this codebase. I need to understand how the payment processing flow works — from when a user submits a payment to when it's confirmed. Can you walk me through it?"

**Claude** calls `get_file_tree` and `search_symbols(query: "payment", kind: "route")`:

```
Payment-related routes:
  POST /v1/payments              services/gateway/src/routes/payments.ts
  POST /v1/payments/:id/capture  services/gateway/src/routes/payments.ts
  GET  /v1/payments/:id          services/gateway/src/routes/payments.ts
```

Entry point found: the gateway service handles incoming payment requests. Claude calls `get_file_outline("services/gateway/src/routes/payments.ts")`:

```
PaymentRoutes
  handleCreatePayment()   POST handler, validates request, forwards to payment service
  handleCapturePayment()  Captures a previously authorized payment
  handleGetPayment()      Returns payment status
```

**Claude:** "Payment requests enter through the gateway service at `handleCreatePayment`. Let me trace what happens from there."

Claude calls `get_context_bundle(symbolId: "handleCreatePayment", maxDepth: 2)`:

```
Context bundle (depth 2, ~2,400 tokens):

  handleCreatePayment()      gateway/routes/payments.ts     — the entry handler
  PaymentServiceClient       gateway/clients/payment.ts     — gRPC client to payment service
  createPayment()            services/payment/src/core.ts   — the actual business logic
  validatePaymentRequest()   services/payment/src/validators.ts
  PaymentRepository          services/payment/src/db/repo.ts
  ChargeProvider             services/payment/src/providers/stripe.ts
```

**Claude:** "The flow is: gateway receives the HTTP request → validates it → calls the payment service via gRPC → the payment service validates the request, saves a record, and calls the Stripe provider. Let me get the source for `createPayment` so you can see the core logic."

You now understand the service topology and the call chain — from an HTTP POST to a Stripe API call — in under 2 minutes, without reading a single file manually.

---

## Finding the bug

**You:** "The bug I'm looking at is that payments are being marked as 'confirmed' even when Stripe returns a 'requires_action' status. Where would that status handling be?"

**Claude** calls `search_symbols(query: "requires_action")`:

```
No exact match. Trying semantic search...

search_semantic(query: "handle stripe payment status requires action") →

  handlePaymentStatus()    services/payment/src/status-handler.ts    similarity: 0.92
  processStripeWebhook()   services/payment/src/webhooks/stripe.ts   similarity: 0.87
  updatePaymentState()     services/payment/src/state-machine.ts     similarity: 0.84
```

**Claude:** "`handlePaymentStatus` looks like the most likely location. Let me retrieve it."

`get_symbol_source(symbolId: "handlePaymentStatus")` returns 67 lines. Claude reads it and finds:

```typescript
case 'requires_action':
case 'requires_payment_method':
  // TODO: implement 3DS handling
  return updatePaymentState(paymentId, 'confirmed'); // ← the bug
```

Found in 4 minutes. Without PureContext, you'd have been reading files in the payment service hoping to find the status handling code.

---

## Understanding the impact before fixing

**You:** "Before I fix this, I need to understand what else depends on `updatePaymentState`. If I change how it works, what breaks?"

**Claude** calls `get_blast_radius(symbolId: "updatePaymentState")`:

```
updatePaymentState() is imported by 8 files:

  services/payment/src/status-handler.ts    (the file we're fixing)
  services/payment/src/webhooks/stripe.ts   (webhook handler)
  services/payment/src/retry.ts             (retry logic)
  services/payment/test/status.test.ts      (tests)
  services/payment/test/integration.test.ts
  services/reporting/src/sync.ts            (cross-service! reporting reads payment state)
  services/audit/src/listeners.ts           (cross-service! audit logs state changes)
  services/notifications/src/triggers.ts    (cross-service! triggers on state changes)
```

**Claude:** "Changing `updatePaymentState` affects three other services: reporting, audit, and notifications. The fix to handle `requires_action` correctly shouldn't break these — they're just listening for state changes — but you should verify the test coverage in each service."

You now know the blast radius of your fix before writing a line. You know which tests to run and which service owners to notify. This conversation — from "I'm new" to "I understand the fix and its impact" — took about 15 minutes.

---

## What made this possible

- **No file browsing.** You never opened a file explorer or searched GitHub. Claude navigated the codebase and retrieved exactly the relevant code.
- **No onboarding sessions needed.** A senior engineer's time was not required. The shared index gave Claude enough context to explain the architecture accurately.
- **Bug found by meaning, not name.** `search_semantic` found `handlePaymentStatus` even though it didn't contain the exact search terms.
- **Impact known before the fix.** `get_blast_radius` revealed the cross-service dependencies that aren't obvious from reading the payment service alone.
- **Token efficient.** The entire session — architecture overview, bug location, blast radius analysis — used roughly 8,000 tokens. Reading the relevant files directly would have cost 50,000+ tokens and still required knowing which files to read.

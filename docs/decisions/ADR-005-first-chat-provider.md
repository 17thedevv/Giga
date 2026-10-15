# ADR-005 — First real GigaChat provider

- Status: 17T-36 implementation candidate; Trà owner, Thư review pending.
- Date: 2026-10-15. API v1 remains DRAFT; no deployment or live-key validation implied.
- Base: main 94736f6cbbcff64dd2b3ce8317e38aab7fe85d1d; related 17T-31/32/35, ADR-004.

## Decision before implementation

Following the user's provider preference, choose **Google Gemini Developer API**, one
stable text model **gemini-3.1-flash-lite**, behind `giga-chat-default`. CHAT_MODEL_ID must
explicitly name this reviewed model. No second provider, fallback or picker is delivered.
Changing the server model allowlist requires review.

Use direct HTTP to fixed `https://generativelanguage.googleapis.com/v1beta/models/` with
the allowlisted model and `:streamGenerateContent?alt=sse`; reject redirects. No SDK,
configurable endpoint or automatic retries. Both adapter methods use one incremental SSE
normalization path; generateText collects the bounded stream. No tool/embedding/structured
capability is enabled. API keys are server-only in GEMINI_API_KEY, sent via x-goog-api-key
header, never query parameters. Credentials pasted into chat are not copied into artifacts.

## Material evaluation (official documentation checked 2026-10-15)

- [Model](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite): stable,
  low-latency text output, 1,048,576 input and 65,536 output tokens. Configure minimal
  thinking and a 1–2,048 output-token cap (default 1,024); retain bounded Giga context.
  Transport bounds are not a tokenizer, quota or entitlement guarantee. The provider's
  stable model code is not an immutable weight/version guarantee.
- [Pricing](https://ai.google.dev/gemini-api/docs/pricing): standard paid text input
  $0.25 and output including thinking $1.50 per million tokens, with a free tier subject
  to eligibility/limits. This is practical for a bounded project MVP, not a workload cost
  estimate or billing feature. Free-tier content may be used to improve Google's products;
  paid-tier terms differ. Deployment must review data handling and account tier.
- [API](https://ai.google.dev/api) and [GenerateContent reference](https://ai.google.dev/api/generate-content)
  document server-side authentication, SSE streamGenerateContent and usageMetadata.
  REST v1beta is explicitly versioned; model stability does not freeze that API. Parse
  text parts, suppress thought parts, validate a terminal finishReason, and require clean
  EOF before normalized completion. Blocked/unsafe/tool responses fail safely.
- Caller AbortSignal reaches Node fetch and immediately cancels response reading;
  late buffered output is discarded. Cancellation is best effort remotely and does not
  guarantee zero billing. Keep Chat's durable Stop/idle/total bounds plus an 85s adapter
  deadline. No cancellation endpoint or remote billing guarantee is invented.
- [Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) depend on project,
  model and tier. Classify 429 with bounded Retry-After metadata, 5xx unavailable, and
  other failures with safe fixed messages. **Automatic retries are deferred**: the engine
  has no retry budget/attempt contract; replay can duplicate cost. Persisted user Retry
  remains explicit, and partial output is never transparently restarted.
- Structured output is supported by this model for future work. Gemini also has a
  documented embedContent API using separate embedding models; neither capability is
  implemented now. Region, key validity, model access, quota, spend and egress remain
  deployment checks. No paid resource or live request is required for deterministic CI.

## Configuration and trusted identity

CHAT_ENABLED defaults off in unconfigured development/tests and on in production. Explicit
false disables chat; supplying model/key/output config enables it unless explicitly disabled.
Enabled chat requires GEMINI_API_KEY and CHAT_MODEL_ID; invalid/partial config fails before
startup DB/socket work. Keys are validated without echoing values or making a live request.
CHAT_MAX_OUTPUT_TOKENS defaults 1,024, bounded 1–2,048. FakeProvider is explicit test
injection only. Health/public DTO/SSE never expose keys, raw model identity or endpoints.

005–007 lacks resolved identity. Forward migration 008 adds nullable internal provider/model
columns with pair consistency and a PostgreSQL write-once trigger. Legacy rows stay null.
At streaming start the engine prepares/resolves once, the runtime records the trusted
identity, then reads the provider. Persistence failure prevents provider invocation.
Alias changes cannot rewrite historical identity or alter an already prepared request.
Stream-only test doubles can retain null; normal production bootstrap uses the real engine.

| Previous behavior | Candidate behavior | Compatibility / evidence |
|---|---|---|
| Startup has no engine | Server config bootstraps one Gemini alias | Startup + injected HTTP tests |
| Generation stores alias only | Internal identity written once at start | Populated 007→008 and PostgreSQL trigger tests |
| Public Chat DTO/SSE | Unchanged | Existing fixtures and non-disclosure regression |
| Explicit test DI | Retained | No external key/network in CI |

No provider switching, Memory, tools, quota ledger, cloud deployment or API freeze.

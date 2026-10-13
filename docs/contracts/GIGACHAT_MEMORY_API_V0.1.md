# GigaChat Memory REST API and DTO Proposal v0.1

> **STATUS: DRAFT / NOT IMPLEMENTED / NOT FROZEN.** This is a **candidate extension** to the canonical [API Contract v0.1](API_CONTRACT_V0.1.md), not a replacement for it. Requires Trà backend + Thư frontend review, contract fixtures and browser auth/CSRF testing under [ADR-001](../decisions/ADR-001-api-compatibility.md). Product choice: Hybrid Memory. Tracking [17T-22](https://linear.app/17thedev/issue/17T-22).

## 1. Global protocol invariants

- Prefix: /api/v1; JSON fields: camelCase; IDs: UUID strings; timestamps: UTC ISO 8601.
- Auth: existing server-managed session cookie; user ID **only from authenticated session**. Never accept an arbitrary userId as ownership authority.
- POST/PATCH/DELETE use reviewed CSRF/origin protections, including the 17T-23 security fix; no permissive cross-origin credentials policy.
- Collection result: { items: [...], nextCursor: string | null }. Single resource: named object.
- Error result: { error: { code, message, details?, requestId? } } with status semantics as in the canonical draft. Never expose secrets, sensitive content or attacker-controlled headers in errors.
- GET/HEAD read-only. Body size/rate limits, content length limits, reliable pagination and anti-enumeration must be validated server-side.
- Do not return raw embeddings, internal prompts, HMAC suppressions, complete background job payloads or hidden content sources.

## 2. Proposed routes

| Method | Route | Request | Response | Authorization / behavior |
|---|---|---|---|---|
| GET | /api/v1/memory/settings | none | 200 { settings } | Session required; defaults returned when row absent |
| PATCH | /api/v1/memory/settings | partial settings + expectedRevision | 200 { settings } | CSRF; atomically increment policy revision; invalidate stale jobs |
| GET | /api/v1/memories?cursor=&limit=20 | optional category/status filters | 200 { items, nextCursor } | Own memory items only; active by default |
| POST | /api/v1/memories | content, category, optional source reference | 201 { memory } | Explicit manual save; idempotency/review |
| GET | /api/v1/memories/:id | none | 200 { memory } | 404 for wrong owner or missing |
| PATCH | /api/v1/memories/:id | content/category + expectedRevision | 200 { memory } | CSRF; 409 on stale revision; re-index |
| DELETE | /api/v1/memories/:id | none | 204 | CSRF; purge vectors, invalidate jobs, suppression policy |
| GET | /api/v1/memory/suggestions?cursor=&limit=20 | pending by default | 200 { items, nextCursor } | Own suggestions only |
| POST | /api/v1/memory/suggestions/:id/decision | decision=accept/reject, idempotencyKey header candidate | 200 { suggestion, memory? } | CSRF; expiry and policy revision checked |

A separate **batch forget / clear suppression-history endpoint is an open design question**, not an agreed v0.1 API. Avoid adding a raw vector search endpoint for public browsers.

## 3. Settings DTO

~~~ts
type MemoryCaptureMode = 'off' | 'suggest' | 'auto';

interface MemorySettings {
  enabled: boolean;           // default false, gates both read and capture
  captureMode: MemoryCaptureMode; // default suggest for future opt-in
  useInChat: boolean;         // default true; effective only if enabled
  revision: number;           // monotonically increases on settings change
  updatedAt: string;          // ISO UTC
}
~~~

GET example (not consented yet):

~~~json
{
  "settings": {
    "enabled": false,
    "captureMode": "suggest",
    "useInChat": true,
    "revision": 0,
    "updatedAt": "2026-10-13T00:00:00.000Z"
  }
}
~~~

PATCH example:

~~~json
{
  "enabled": true,
  "captureMode": "suggest",
  "expectedRevision": 0
}
~~~

Rules: enabling requires a deliberate UI action. Switching to auto requires a separately explicit action; no implicit escalation. Disabling increments revision/policy_epoch, blocks retrieval immediately, invalidates queued extraction/indexing effects but **does not erase** already stored memory. captureMode=off disallows automatic/suggested extraction; authorized manual saves remain possible while enabled=true. useInChat=false suppresses retrieval without deleting items.

## 4. Memory resource DTO

~~~ts
type MemoryCategory = 'preference' | 'fact' | 'project_decision' | 'goal';
type MemoryOrigin = 'manual' | 'suggested' | 'automatic';
type MemoryIndexStatus = 'pending' | 'ready' | 'failed';

interface MemoryItem {
  id: string;
  content: string;
  category: MemoryCategory;
  origin: MemoryOrigin;
  scope: 'global';  // v0.1; project scope is deferred
  revision: number;
  indexStatus: MemoryIndexStatus;
  createdAt: string;
  updatedAt: string;
  sources?: Array<{
    conversationId: string;
    messageId: string;
    createdAt: string;
  }>; // only currently authorized surviving source links
}
~~~

POST /api/v1/memories (manual save):

~~~json
{
  "content": "The Giga project uses PostgreSQL.",
  "category": "project_decision",
  "scope": "global"
}
~~~

201 response:

~~~json
{
  "memory": {
    "id": "f9749c40-ef4f-4717-a3ef-c6edbddc8b10",
    "content": "The Giga project uses PostgreSQL.",
    "category": "project_decision",
    "origin": "manual",
    "scope": "global",
    "revision": 1,
    "indexStatus": "pending",
    "createdAt": "2026-10-13T08:00:00.000Z",
    "updatedAt": "2026-10-13T08:00:00.000Z"
  }
}
~~~

No client-controlled origin field; server decides origin. Source messages may only be attached through validated, same-owner identifiers or server-side chat-save orchestration. A manual "remember this" chat command must trigger the same authenticated, auditable save path and may acknowledge success **only after commit**. Pending/failed indexStatus is visible, not silently treated as ready. A future fallback lexical lookup is separate from vector-ready behavior.

PATCH body: { content, category?, expectedRevision } (at least one mutable change). On success: increment revision, invalidate old vector, enqueue idempotent embedding job. Return 409 CONFLICT for stale expectedRevision; validate lengths, categories and abuse limits. DELETE responds 204 on successful removal, and another request may return 204 or 404 according to a reviewed idempotence rule; NEVER expose cross-owner resource existence.

List pagination: limit default 20, maximum reviewed (candidate 100); opaque stable cursor sorted by updatedAt DESC and id DESC; server derives owner. Only active memory items appear unless an explicit safe status filter is documented.

## 5. Suggestions DTO and decisions

~~~ts
type SuggestionStatus = 'pending' | 'accepted' | 'rejected' | 'expired';

interface MemorySuggestion {
  id: string;
  proposedContent: string;
  category: MemoryCategory;
  status: SuggestionStatus;
  createdAt: string;
  expiresAt: string;
  source?: { conversationId: string; messageId: string };
}
~~~

GET /api/v1/memory/suggestions returns pending items. Accepted/rejected suggestions may be retrieved as history only if explicitly reviewed.

POST /api/v1/memory/suggestions/:id/decision:

~~~json
{ "decision": "accept" }
~~~

200 response (accept):

~~~json
{
  "suggestion": {
    "id": "9d1a2278-8490-48cd-8b7c-8904139e52fe",
    "status": "accepted"
  },
  "memory": {
    "id": "f9749c40-ef4f-4717-a3ef-c6edbddc8b10",
    "indexStatus": "pending"
  }
}
~~~

Accept and memory creation must occur in **one transaction**, with a durable unique acceptance effect. Duplicate retries must not duplicate memories. Reject creates no long-term memory. Stale/expired suggestion is rejected consistently (proposed 409); wrong owner is 404. Policy turned off before decision -> cannot unexpectedly create a memory. Pending suggestions are NEVER sent to Chat Retriever.

Review whether Idempotency-Key is required for POST create and decision; document retry/error behavior for Frontend before freezing this interface.

## 6. Internal chat integration (not an extra public route)

The existing DRAFT POST /api/v1/conversations/:id/messages:stream remains the only chat streaming entrypoint. On eligible requests, the backend may retrieve personal memory internally, then build a bounded prompt. It must not add or modify existing SSE event names/order without contract review.

Possible future transparency API (not in MVP): GET /api/v1/conversations/:id/messages/:messageId/context returning safe memory IDs/categories used, no embeddings, secret prompts or deleted sources. Do not introduce it silently in implementation.

## 7. Error and UI states

| Situation | Proposed status / error | UI |
|---|---|---|
| No session | 401 UNAUTHENTICATED | Sign in |
| Cross-owner memory ID | 404 NOT_FOUND | Generic missing state |
| Invalid content, category, query | 400 VALIDATION_ERROR | Inline field feedback |
| Unsafe/missing CSRF Origin | 403 FORBIDDEN | Safe retry/config explanation |
| Stale optimistic revision | 409 CONFLICT | Refresh before saving |
| Expired or already finalized suggestion | 409 CONFLICT or idempotent previous result | Refresh proposal |
| Limits exceeded | 429 RATE_LIMITED | Retry guidance |
| Embedding unavailable | Memory indexStatus=failed/pending; Chat still available | Explicit indexing state |
| No memories | 200 { items: [], nextCursor: null } | Empty state |
| Memory disabled | 200 settings with enabled=false; retrieval disabled | Settings explanation |

API handlers never return another user's content in either successful payloads or validation diagnostics. Build shared typed DTOs in packages/contracts only **after** review; frontend must not import backend implementation.

## 8. Compatibility review checklist

- [ ] Frontend: consent dialog, auto opt-in, memory list/edit/delete, suggestion accept/reject, empty/loading/conflict states.
- [ ] Backend: auth owner scoping, CSRF, exact DTO/error semantics and rate/body limits.
- [ ] Both: source visibility, suppressions, deletion and old-chat retention disclosure.
- [ ] Both: choose whether edits use expectedRevision body or HTTP If-Match (do not implement both without a documented policy).
- [ ] Both: determine POST idempotency header policy and exact duplicate-delete semantics.
- [ ] Both: test cookie/browser CSRF topology after 17T-23 and cloud integration.
- [ ] Both: preserve existing API draft conversation/auth routes and SSE event framing.

**Status remains DRAFT; there are no implemented Memory public endpoints in this document.**
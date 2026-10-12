---
name: giga-contract-guardian
description: Guards Giga public API, TypeScript DTO, authentication, SSE event schemas, persisted contract and breaking-change decisions. Use before creating, reviewing, or altering API routes, client/server payloads, streaming, auth or agent statuses.
---

# Contract-first changes

**First read:** `docs/contracts/API_CONTRACT_V0.1.md`, `docs/decisions/ADR-001-api-compatibility.md`, and `docs/architecture/INVARIANTS_V0.1.md`. Inspect real `packages/contracts` files only if they exist.

## Route decision
1. Identify client-visible surface: method/path, headers/cookies, request DTO, response/error shape, pagination, SSE event stream, auth, or status transitions.
2. Determine contract status from evidence: `DRAFT` is discussable; `FROZEN` only when joint sign-off, fixture tests and deployed browser checks are recorded.
3. Compare proposed changes to canonical spec and actual code. Write a compatibility table: **old behavior / new behavior / affected clients / additive or breaking / evidence**.
4. If DRAFT: prepare smallest candidate contract update with explicit frontend and backend review questions. Do not claim sign-off.
5. If FROZEN: preserve all old behavior. Avoid renaming/removing paths or fields, changing field types/nullability/requiredness, event names/order/terminal semantics, enum behavior, auth expectations or error/status meaning.
6. A genuinely breaking change needs a new `/api/v2` interface or an explicitly reviewed compatibility/migration plan. Emergency security fixes need a documented impact/rollback path.

## Shared DTO & validation rules
- One canonical type/schema surface lives in `packages/contracts` once created. Prefer generating/deriving client and server types from a shared runtime schema rather than hand-copying interfaces.
- Backend performs runtime validation and authentication; compile-time TypeScript types do not validate network input.
- Avoid unintended extra data: response JSON is intentional, stable, and safe for client use.
- SSE with POST chat is `fetch()` streaming; event framing must be valid with JSON payloads, a documented terminal event and error path. Existing clients must tolerate only explicitly supported event extensions.
- For auth, test cookie+credentials+CSRF+cross-origin behavior in the **actual deployed browser topology** before freeze.

## Contract verification
- Add or update positive/negative request fixtures, error compatibility tests, SSE ordering/parsing tests, unauthorized-owner tests and idempotency tests when relevant.
- If `packages/contracts` or CI does not exist, document missing prerequisites rather than claiming tests passed.
- Document any contract freeze transition with reviewers, commit SHA, tests, known limitations and a new ADR/change-log entry.

## Output
Return the compatibility assessment, spec/code files affected, exact test evidence, required frontend review and whether v1 is still DRAFT or has genuinely been FROZEN.

**Never silently reinterpret an existing v1 endpoint because the old interface is inconvenient.**

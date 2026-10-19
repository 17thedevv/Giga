# Backend Gemini key pool — candidate verification

Issue: 17T-91. Operator: Codex, acting on user request. Intended peer review: Thư for backend integration; no human approval recorded.

The backend accepts optional GEMINI_API_KEYS as a JSON array of 1–8 keys. It validates and deduplicates keys; the array takes precedence over legacy GEMINI_API_KEY. Single-key configuration continues to work. Secrets remain server-only. No dependency, API route, DTO, database migration or public error/SSE shape changes.

Each platform request starts at the next eligible key. HTTP 429 cools a key for the provider Retry-After (default 30s), HTTP 401/403 disables it for the process. At most one HTTP attempt per eligible key in a generation; no retry of network exceptions, 5xx, accepted HTTP bodies or partial text. The adapter's existing overall deadline and abort signal cover all attempts. No fallback from explicit user BYOK. All-disabled reports existing provider failure; cooling reports existing rate-limit error. Pool status is process-local and resets on restart. Keys in the same Google project can share quota; this does not increase quota or bypass provider limits.

Compatibility: legacy one-key behavior retained; opt-in pool changes pre-body request selection and latency, not client contracts. The canonical API remains DRAFT. Rollback: remove GEMINI_API_KEYS and retain the working legacy key, then redeploy; no data rollback required.

Validation on Windows / Node 24: typecheck PASS; build PASS; focused Gemini suite 49 PASS; full API suite 464 PASS, 25 SKIP, 0 FAIL (489 total). Skips require dedicated real PostgreSQL. Test coverage includes rotation, deduplication, bounded exhaustion, cooldown/recovery, invalid authentication, discarded body cleanup, abort, overall deadline, BYOK isolation, no replay after partial text and generic config errors. Actual live-key checks and deployment SHA are tracked separately in deployment evidence; these tests use placeholders and fake transport.

Review questions: confirm process-local cooldown is sufficient for this single-instance demo, provider Retry-After handling, quota/cost expectations, and opt-in precedence. Multi-instance shared scheduling and persisted key health are outside scope.

# ADR-006 — Optional encrypted Gemini credentials for Chat

Status: implementation candidate for 17T-37; independent Thư review pending.
Date: 2026-10-15. Owner: Trà. API v1 remains **DRAFT**.

## Decision

Platform credentials remain the default. An authenticated user may explicitly
select their own Gemini credential for Chat. Provider/model resolution and
credential resolution are separate trust boundaries: `giga-chat-default` still
resolves to the reviewed `gemini-3.1-flash-lite` adapter. The Gemini HTTPS origin,
model and transport paths are server constants. No caller can set a provider URL,
base URL, raw model ID or another provider.

Credential management and Chat preference are separate from Skills preferences.
Only the authenticated owner can save, inspect metadata, validate, delete or select
a key. Responses explicitly project metadata; no saved plaintext, ciphertext, IV,
tag, key version or fingerprint is returned. The display hint includes only four
trailing characters. Mutation requests retain the existing session/Origin CSRF
checks, with a 2 KiB body limit and no-store responses.

Migration **009** adds `user_provider_credentials` and
`chat_credential_preferences`. AES-256-GCM uses a fresh 96-bit nonce and 128-bit
authentication tag. AAD binds product, owner, provider, credential ID and key
version. The dedicated `CREDENTIAL_ENCRYPTION_KEY` is canonical base64 decoding to
exactly 32 bytes. Version 1 is explicit; no other key version is accepted.
Missing configuration disables BYOK, including in production; platform Chat stays
available. Supplying malformed configuration fails startup. Missing, invalid or
undecryptable selected credentials never fall back to platform billing.

Replacement creates a fresh immutable credential ID inside one transaction,
deletes the old encrypted row and rebinds an existing BYOK preference. A user-row
lock serializes first save, replacement, selection and deletion. One credential
per owner/provider and a composite owner/credential FK enforce scope in PostgreSQL.
Deletion clears the selected ID before removing the row, retaining `mode=byok`.
Chat then returns a safe configuration failure until platform is selected or a
replacement is saved. Direct deletion of a selected row is restricted by the FK;
account deletion cascades both tables. No historical generation identity is
modified and no secret is persisted on a generation.

## Request lifetime and races

Every new message, Retry and Regenerate first validates the ordinary model alias.
After the generation starts and model identity is recorded, the engine resolves
the authenticated owner's preference and encrypted row with **one MVCC SELECT**,
then decrypts immediately before invoking the adapter. This is the credential
selection point, not HTTP admission. An admitted generation waiting to reach this
point uses the then-current preference. The resulting capability is private to
that provider invocation; replacement, deletion or preference changes after this
point affect future calls only. No current-user key exists on the shared adapter.

The credential is a separate transport argument, never a field of `LLMRequest`,
messages, context, Skills or activation manifests. Private JavaScript fields hide
plaintext from ordinary serialization/inspection. Strings and fetch internals
cannot be reliably zeroized in JavaScript; decrypted byte buffers are cleared and
references become collectible when the request ends. No per-user credential cache
is maintained. `last_used_at` records resolution for an attempted call, not proof
of a successful provider response. Credential-source audit columns are deferred;
historical generations do not claim a reconstructable credential source.

The existing AbortSignal and durable Stop fences remain in effect, including
cancellation during credential resolution. A cancelled resolution cannot later
invoke the provider. There is no automatic provider retry or platform fallback.

## Validation and errors

Stored-key validation sends a GET with `x-goog-api-key` to the fixed reviewed model
metadata path, with no prompt and no request-supplied key/model/URL. This follows
Google's [models.get API](https://ai.google.dev/api/models#method:-models.get).
It has a 10-second deadline, rejects redirects, cancels response bodies and never
reads provider error text. A 2xx response means metadata access succeeded; it does
not guarantee generation quota or permission for every operation. 401/403 mark
invalid. Network errors, 429 and other provider failures retain the prior status;
all attempted probes update `last_validated_at`.

Chat maps missing/decryption configuration to `CHAT_CREDENTIAL_UNAVAILABLE`, known
invalid or provider-rejected 401/403 to `BYOK_CREDENTIAL_INVALID`, and BYOK 429/5xx/
timeout to safe provider codes. SSE ordering and the generic safe error message
remain unchanged. Platform generation error semantics remain unchanged. Raw
provider bodies, headers, exception causes, stacks and encryption details never
enter these error DTOs or application logs.

## Permission boundaries and hardening

This grants **Chat only** BYOK. Agent, Memory/RAG and plugin/tool services receive
neither the resolver nor encryption service. The engine rejects Chat credential
resolvers for Agent/Memory callers, and the Gemini adapter rejects user credentials
on non-Chat requests. Skills/custom instructions are text and cannot invoke
credential retrieval. Memory/RAG and Agent runtime integration remain unimplemented;
this change adds no retrieval or delegation capability for them.

The application DB role necessarily sees encrypted rows; compromise of both DB and
the application master key permits decryption. Production hardening should use a
secret manager/KMS, separate key-access policies, rotation with a versioned keyring,
and operational request/header redaction. Never rotate this single version in place
without a reviewed re-encryption migration. Do not log request bodies, credential
headers or secret configuration in proxies/APM. KMS, rotation, frontend settings,
multi-provider support, billing/fallback UX and Agent BYOK are outside this task.

## Review questions

- Confirm paths/DTO envelopes and safe error codes with Thư and the frontend task.
- Confirm replacement reselects the new ID when BYOK mode was already selected.
- Confirm metadata-only validation and selection at provider invocation rather than admission.
- Confirm production treats an absent encryption key as BYOK disabled, preserving platform mode.

Related: [17T-37](https://linear.app/17thedev/issue/17T-37),
[first provider](ADR-005-first-chat-provider.md),
[DRAFT contract](../contracts/CHAT_BYOK_API_V0.1.md).

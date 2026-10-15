# Chat BYOK API v0.1 — DRAFT implementation candidate

Tracking: [17T-37](https://linear.app/17thedev/issue/17T-37).
Owner Trà; reviewer Thư. Independent review and deployed browser checks pending.
See [ADR-006](../decisions/ADR-006-chat-byok-credentials.md).

All routes require an active session. State-changing methods require an allowed
Origin under the existing CSRF policy. Bodies are strict objects, at most 2048
bytes. Metadata/preferences responses set `Cache-Control: no-store`.

| Method | Path under `/api/v1/me` | Request | Response |
|---|---|---|---|
| GET | `/provider-credentials` | none | 200 `{items: CredentialMetadata[]}` |
| POST | `/provider-credentials` | `{provider:"gemini",apiKey:string}` | 201 `{credential: CredentialMetadata}`; atomically replaces existing key |
| DELETE | `/provider-credentials/:id` | none | 204; missing/foreign ID 404 |
| POST | `/provider-credentials/:id/validate` | empty body or `{}` | 200 `{credential: CredentialMetadata}`; missing/foreign ID 404 |
| GET | `/chat-credential-preference` | none | 200 `ChatCredentialPreference` |
| PUT | `/chat-credential-preference` | `{mode:"platform"}` or `{mode:"byok",credentialId:UUID}` | 200 `ChatCredentialPreference`; missing/foreign credential 404 |

```ts
interface CredentialMetadata {
  id: string;
  provider: 'gemini';
  displayHint: string; // mask plus last four characters only
  status: 'unverified' | 'valid' | 'invalid';
  createdAt: string;
  updatedAt: string;
  lastValidatedAt: string | null;
}
interface ChatCredentialPreference {
  mode: 'platform' | 'byok';
  credentialId: string | null;
}
```

The POST key input is 16–512 ASCII characters in U+0021–U+007E, without trimming.
It is never returned after save. Invalid provider/key/extra fields return 400
`VALIDATION_ERROR`; oversized bodies do too. Path IDs must be UUIDs. No URL/raw
model/custom provider input is accepted. Collection is bounded to one item; no
pagination is needed. A selected deleted key yields `{mode:"byok",credentialId:null}`;
saving a replacement while BYOK is selected rebinds that preference to the new ID.
Newly saved keys are unverified and may be used without a separate validation call.

Validation 401/403 returns metadata with `status=invalid`. Transient failures
return 429 `PROVIDER_RATE_LIMIT` or 503 `PROVIDER_UNAVAILABLE`, retaining status and
recording attempt time. Disabled encryption/decryption failures return 503
`CHAT_CREDENTIAL_UNAVAILABLE`. Response envelopes use the common `{error:{code,message}}`.

For Chat generation failures after stream start, the existing `stream.error` then
`message.failed` events retain the same generic safe message. Additive BYOK codes:
`CHAT_CREDENTIAL_UNAVAILABLE`, `BYOK_CREDENTIAL_INVALID`, `PROVIDER_RATE_LIMIT`,
`PROVIDER_UNAVAILABLE`, `PROVIDER_TIMEOUT`. No raw provider response is included.
The public alias remains `giga-chat-default`. Source selection occurs once at
provider invocation; each Retry/Regenerate resolves current preference again.

| Old behavior | Candidate behavior | Clients / compatibility | Evidence |
|---|---|---|---|
| Platform-only Chat | Platform remains default; explicit Chat BYOK preference | Existing Chat requests unchanged | Provider and BYOK routing tests |
| No credential endpoints | Dedicated authenticated metadata/preference routes | Additive; frontend settings deferred to 17T-39 | REST/auth/CSRF fixtures |
| Generic failed SSE | Existing frames/message; additional codes for BYOK only | Opt-in BYOK clients must handle codes; platform unchanged | Transport failure tests |
| Model alias/Stop/variants | Same allowlist, identity, AbortSignal and terminal fences | Unchanged | Full Chat regression suite |
| Migrations through 008 | Forward-only 009; no changes to historical rows | Additive persistence | Populated-008 upgrade, FK/race tests |

Both frontend/backend review remain open. API v1 is **DRAFT**, with no freeze or
deployment assertion made by this document. Shared runtime schemas are not yet
implemented in `packages/contracts`; this task keeps DTO projection in the API.

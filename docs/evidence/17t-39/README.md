# Gemini BYOK Settings & Credential UX — Local Evidence

Issue: [17T-39](https://linear.app/17thedev/issue/17T-39/implement-gemini-byok-settings-and-credential-ux).
Backend dependency: [17T-37](https://linear.app/17thedev/issue/17T-37/implement-backend-credential-storage-encryption-and-validation-apis) (merged in `main`, ADR-006).
PR: `feat(web): add Gemini BYOK settings UI` ([PR #35](https://github.com/17thedevv/Giga/pull/35)).
Branch: `feat/17t-39-byok-settings-ui`.
Date: 2026-10-19 (Asia/Saigon).

---

## 1. Scope & Architecture

Web frontend implementation for Bring Your Own Key (BYOK) credential management and chat credential mode selection, backed by the authoritative backend credential API from ADR-006.

### Architectural Invariants & Security Guarantees
- **No Plaintext Key Retention**: API keys are submitted strictly over TLS via `POST /api/v1/me/provider-credentials`. The frontend holds plaintext input only in component-local form state during entry, immediately zeroing and clearing state upon modal submit or dismissal. Plaintext is never stored in browser storage (`localStorage`, `sessionStorage`, IndexedDB), query parameters, or client telemetry.
- **Masked Key Display**: Only the backend-derived safe masked hint (`••••<last4>`) is received and rendered in UI markup.
- **Authoritative Credential State**: Follows backend ADR-006 contracts:
  - `GET /api/v1/me/provider-credentials`: Returns `ProviderCredential[]` (1 per provider type).
  - `POST /api/v1/me/provider-credentials`: Atomic insert or replace with AES-256-GCM backend encryption and automatic rebind if BYOK active.
  - `DELETE /api/v1/me/provider-credentials/:id`: Deletes credential; if active in BYOK, preference retains `mode: 'byok'` with `credentialId: null`.
  - `POST /api/v1/me/provider-credentials/:id/validate`: Triggers server-side key validation using empty payload `{}`.
  - `GET /api/v1/me/chat-credential-preference`: Retrieves active chat credential mode (`platform` vs `byok`).
  - `PUT /api/v1/me/chat-credential-preference`: Updates mode to `platform` or `byok`.
- **Zero Silent Fallback**: When `mode === 'byok'` and no usable credential exists (e.g. key deleted or missing), the UI displays a prominent `byok-configuration-error` banner notifying the user that BYOK is active without an active key. The system never silently falls back to the platform key when the user explicitly chose BYOK.
- **Transient Failure Resilience**: Network errors and transient upstream failures (429 rate limit, 503 service unavailable) during validation do not overwrite or invalidate previously valid credentials.
- **Dual Runtime Support & Asynchronous Fencing**: Fully functional under both `mock` (demo mode with comprehensive mock adapter simulation) and `real` backend environments, with strict request fencing that isolates mode-specific metadata.

---

## 2. Review Follow-Up: Addressing PR #35 Review Findings

Reviewed head: `5f45a19`. Addressed review findings across components and test coverage:

1. **P1 — Contradictory BYOK Fallback Messaging (`GeminiProviderCard.tsx`)**:
   - Fixed the empty-state and details-row status messaging to cleanly distinguish:
     * **Platform mode without credential**: `"Platform key selected. No custom Gemini API key configured."`
     * **BYOK mode without credential**: `"My Gemini Key (BYOK) is selected, but no key is configured. Chat is unavailable until configuration is fixed."`
     * **BYOK mode with invalid credential**: Dedicated `byok-invalid-notice` (`"Selected key is unusable. Chat is unavailable with no automatic fallback."`) and configuration error alert (`"Selected key is unusable; there is no automatic fallback to the platform key."`).
   - Under no circumstance do missing or invalid BYOK states claim that platform mode is active or that Giga is using the platform key.

2. **P1 — Independently Scoped Operation Identities & Concurrent Action Protection (`SettingsView.tsx`)**:
   - Replaced single global operation counter with independently scoped operation identity refs (`loadOpIdRef`, `validateOpIdRef`, `modeOpIdRef`, `saveOpIdRef`, `deleteOpIdRef`).
   - Allowed concurrent actions (such as Validate &rarr; Mode Change or Mode Change &rarr; Validate) no longer invalidate one another.
   - Each action's `finally` block verifies its own scoped identity, guaranteeing that loading indicators (`isValidating`, `isSavingMode`, `loading`) always recover and never remain stuck.
   - Authoritative backend state is reflected accurately regardless of promise resolution ordering.
   - Full Real/Mock stale-response protection is preserved via `activeModeRef` and synchronous mode invalidation.

3. **P2 — Persistent Initial Load Failure & Visible Retry (`SettingsView.tsx`)**:
   - When initial settings loading fails (HTTP 500/503), the view displays an initial error state with a prominent visible Retry button (`data-testid="settings-load-retry-btn"`).
   - Dismissing the top alert banner (`errorBanner`) does not unmount or clear the retry state; `settings-initial-error-state` and the Retry button remain persistently visible until a retry attempt succeeds or the user switches API modes.

4. **Additional Consistency Checks (Partial Success in Mutations)**:
   - Handled partial success scenarios (saving succeeds but preference refresh fails, deleting succeeds but metadata refresh fails, mode change request response lost):
   - The frontend reconciles authoritative backend state rather than reporting false failures or permitting repetitive destructive mutations.

---

## 3. Executed Validation Summary

Environment: Windows, Node v24.12.0, npm 11.6.2. Base: `e86edd9` from `origin/main`.

| Verification Check | Target | Result | Details |
| --- | --- | --- | --- |
| Unit & Integration Tests | `apps/web/tests/byok-settings.test.tsx` | **PASS (29/29)** | 17 base scenarios + 12 review regression tests |
| Mock Adapter Tests | `apps/web/tests/mock-adapter.test.ts` | **PASS (21/21)** | Full adapter test suite including BYOK and credentials |
| Full Web Test Suite | `npm test --prefix apps/web` | **PASS (176/176)** | 12 test files passed, 0 failures, exit code 0 |
| Frontend Typecheck | `npm run typecheck --prefix apps/web` | **PASS (0 errors)** | Strict TypeScript validation |
| Production Build | `npm run build --prefix apps/web` | **PASS** | Vite production bundle built in 809ms |
| Git Workflow Verification | `node --test .agents/scripts/validate-git-workflow.test.mjs` | **PASS (6/6)** | Verified branch name & conventional commit compliance |
| Skill System Validation | `node .agents/scripts/validate-skills.mjs` | **PASS (8/8)** | All repo skills valid |
| Git Whitespace / Diff Check | `git diff --check` | **PASS** | Clean diff, no trailing whitespace or formatting flaws |

---

## 4. Local Browser Evidence (Edge Headless CDP @ `http://localhost:4173/settings`)

All 7 browser evidence screenshots captured using headless Edge CDP automation against production preview build:

1. **Empty State (`screen_17t_39_empty_state.png`)**:  
   Displays Settings page with Gemini provider card, empty key indicator, default "Giga Platform Key" mode, and "Add Gemini Key" button.  
   ![Empty State](screen_17t_39_empty_state.png)

2. **Add Credential Modal (`screen_17t_39_add_modal.png`)**:  
   Displays the secure Add Gemini API Key modal with password input, show/hide toggle, character requirements, and link to Google AI Studio.  
   ![Add Key Modal](screen_17t_39_add_modal.png)

3. **Saved Valid Key & BYOK Active (`screen_17t_39_saved_valid.png`)**:  
   Displays saved key with `Valid` green badge, masked key hint `••••AIza`, last validated timestamp, Validate/Replace/Delete actions, and BYOK mode active.  
   ![Saved Valid Key](screen_17t_39_saved_valid.png)

4. **Invalid Key Feedback (`screen_17t_39_invalid_feedback.png`)**:  
   Displays `Invalid` badge and error alert banner after validation failure with guidance to replace the key.  
   ![Invalid Feedback](screen_17t_39_invalid_feedback.png)

5. **Delete Confirmation Modal (`screen_17t_39_delete_modal.png`)**:  
   Displays explicit delete confirmation modal with prominent warning that BYOK mode is currently active.  
   ![Delete Modal](screen_17t_39_delete_modal.png)

6. **BYOK Configuration Error Banner (`screen_17t_39_byok_error.png`)**:  
   Displays prominent `byok-configuration-error` warning banner when BYOK mode is active without a valid credential, enforcing zero silent fallback.  
   ![BYOK Error Banner](screen_17t_39_byok_error.png)

7. **Mobile Responsive View (`screen_17t_39_mobile.png`)**:  
   Displays Settings view rendered on mobile viewport (390x844) with mobile navigation bar, responsive card padding, and full touch accessibility.  
   ![Mobile Layout](screen_17t_39_mobile.png)

---

## 5. Review Readiness

- **Status**: **READY FOR INDEPENDENT REVIEW**.
- **Pull Request**: Draft PR #35 targeting `main`.
- **Reviewer**: Assigned for peer review.

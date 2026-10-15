# Giga API

**Purpose:** Authenticated TypeScript backend service built with Node.js and Hono, providing persistent user accounts, session-based authentication, streaming AI Chat, coding-agent orchestration, and operations.

> **Status:** Runnable backend with PostgreSQL persistence and session authentication (Task 17T-20). The API Contract remains **DRAFT** until joint review and freeze at the W1/W2 gate.

---

## 1. Architecture & Module Boundaries

- `src/app/`: HTTP application factory (`createApp`), configuration loader, and server socket entry point (`startServer`).
- `src/db/`:
  - `client.ts`: PostgreSQL connection pool management via `pg.Pool`, health ping probe, and credential URL redaction.
  - `migrate.ts` & `migrate-cli.ts`: Deterministic, transaction-safe migration runner tracking executed versions in `schema_migrations`.
  - `migrations/`: Forward-only SQL migration scripts.
  - `repositories/`: Type-safe data access layer (`UserRepository`, `SessionRepository`) using parameterized queries.
- `src/modules/auth/`:
  - `password.ts`: Memory-hard password hashing and verification using **Argon2id**.
  - `session.ts`: Cryptographically secure 256-bit token generation (`crypto.randomBytes(32)`), SHA-256 token hashing, and cookie configuration.
  - `auth-validation.ts`: Runtime input validation and structured domain error definitions.
  - `auth-service.ts`: Core authentication logic (register, login, session validation, logout).
  - `auth-middleware.ts`: Reusable session authentication middleware for protected routes.
  - `csrf-middleware.ts`: Origin validation for state-changing HTTP requests.
  - `auth-routes.ts`: HTTP endpoints mounted under `/api/v1/auth`.
- `src/modules/skills/`:
  - `types.ts`: Domain models, activation manifest interfaces, and structured domain errors.
  - `parser.ts`: Strict parser for supported text-only `SKILL.md` subset with deterministic SHA-256 hashing.
  - `storage.ts`: Storage abstraction (`SkillStorage`) and in-memory implementation (`InMemorySkillStorage`).
  - `resolver.ts`: Policy-guarded Resolver enforcing tenant isolation, enablement, product compatibility, and budget bounds.
  - `composer.ts`: Instruction Composer with conflict detection, user prompt style precedence, and immutable activation manifests.
- `tests/`: Automated unit and integration test suites.

---

## 2. Database Schema

The database design uses strict foreign keys, UTC timestamps, and uniqueness constraints:

### `users` table
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | `PRIMARY KEY DEFAULT gen_random_uuid()` | Unique user identifier |
| `email` | `VARCHAR(255)` | `NOT NULL` | User email (case-insensitive unique index) |
| `display_name` | `VARCHAR(100)` | `NOT NULL` | Public display name |
| `password_hash` | `VARCHAR(255)` | `NOT NULL` | Argon2id password hash |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT NOW()` | Account creation time |
| `updated_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT NOW()` | Last update timestamp |

### `sessions` table
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | `PRIMARY KEY DEFAULT gen_random_uuid()` | Unique session record ID |
| `user_id` | `UUID` | `NOT NULL REFERENCES users(id) ON DELETE CASCADE` | Associated user |
| `token_hash` | `VARCHAR(64)` | `NOT NULL UNIQUE` | SHA-256 hash of the 256-bit session token |
| `expires_at` | `TIMESTAMPTZ` | `NOT NULL` | Session expiry timestamp (7 days) |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT NOW()` | Session establishment timestamp |
| `revoked_at` | `TIMESTAMPTZ` | `NULL` | Revocation timestamp on logout |

### `schema_migrations` table
| Column | Type | Constraints | Description |
|---|---|---|---|
| `version` | `INTEGER` | `PRIMARY KEY` | Incremental migration version |
| `name` | `VARCHAR(255)` | `NOT NULL` | Migration identifier |
| `applied_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT NOW()` | Execution timestamp |

---

## 3. Configuration & Environment Variables

Create `.env` based on `.env.example`:

```bash
cp .env.example .env
```

| Variable | Type | Default | Description |
|---|---|---|---|
| `PORT` | Integer (1–65535) | `3000` | HTTP port. Fails fast at startup if invalid. |
| `DATABASE_URL` | String | *(optional in dev/test)* | PostgreSQL connection URL for application runtime. Required in production. |
| `TEST_DATABASE_URL` | String | *(optional)* | Dedicated test database URL. Required for running tests against real PostgreSQL. Never used for production. |
| `NODE_ENV` | String | `development` | Environment mode (`development`, `production`, `test`). |
| `COOKIE_SECURE` | Boolean | `false` in dev, `true` in prod | Sets `Secure` flag on session cookies (requires HTTPS in production). |
| `COOKIE_SAME_SITE` | String | `lax` | Cookie `SameSite` policy (`lax`, `strict`, or `none`). |
| `ALLOWED_ORIGINS` | String (csv) | `localhost:5173, localhost:3000` (dev) | Trusted origins for CSRF origin validation. Required in production; wildcard `*` forbidden in production. |

---

## 4. Local Development & PostgreSQL Setup

### Option A: Local Docker PostgreSQL
Start the local PostgreSQL container:

```bash
docker compose -f ../../infra/docker/docker-compose.dev.yml up -d
```

### Option B: Automatic In-Memory Fallback for Tests
Automated tests automatically fall back to an isolated in-memory PostgreSQL engine (`pg-mem`) when neither `TEST_DATABASE_URL` nor `DATABASE_URL` is set, allowing instant test runs on any developer workstation without local Docker.

### Option C: Integration Tests with Real PostgreSQL (`TEST_DATABASE_URL`)
To run integration tests against a real PostgreSQL instance:
1. Ensure `NODE_ENV=test`.
2. Provide a dedicated test database connection URL via `TEST_DATABASE_URL`:
   ```bash
   NODE_ENV=test TEST_DATABASE_URL="postgres://giga:giga_dev_password@localhost:5432/giga_test" npm test
   ```
   **Safety invariant:** Tests **fail fast** and strictly refuse to execute destructive table cleanup if `TEST_DATABASE_URL` is missing, if `NODE_ENV !== 'test'`, or if the database name/host matches forbidden environments (`prod`, `production`, `live`, `stage`, `main`, etc.). The test runner will **NEVER** run destructive cleanup against the primary application `DATABASE_URL`.

### Run Migrations
Run forward database migrations against your configured database:

```bash
npm run migrate
```

---

## 5. Development & Execution Scripts

All commands run inside `apps/api`:

```bash
# Install dependencies reproducibly
npm ci

# Start development server with live reload
npm run dev

# Run TypeScript strict typecheck
npm run typecheck

# Build production bundle to dist/
npm run build

# Start production server
npm start

# Run automated tests
npm test
```

---

## 6. API Endpoints & Request Examples

### Health Check (Process Health)
- **`GET /health`** (200 OK)
  Lightweight process health probe that does not require database access.
  ```json
  {
    "status": "ok",
    "service": "giga-api",
    "timestamp": "2026-10-13T03:10:35.887Z"
  }
  ```

### Registration
- **`POST /api/v1/auth/register`** (201 Created)
  Request:
  ```json
  {
    "email": "user@example.com",
    "password": "StrongPassword123!",
    "displayName": "Test User"
  }
  ```
  Response:
  ```json
  {
    "user": {
      "id": "1e86a032-4166-4e5a-939e-e31b798782a2",
      "email": "user@example.com",
      "displayName": "Test User",
      "createdAt": "2026-10-13T03:45:00.000Z"
    }
  }
  ```

### Login
- **`POST /api/v1/auth/login`** (200 OK)
  Request:
  ```json
  {
    "email": "user@example.com",
    "password": "StrongPassword123!"
  }
  ```
  Response:
  ```json
  {
    "user": {
      "id": "1e86a032-4166-4e5a-939e-e31b798782a2",
      "email": "user@example.com",
      "displayName": "Test User",
      "createdAt": "2026-10-13T03:45:00.000Z"
    }
  }
  ```
  Headers:
  `Set-Cookie: giga_session=<64-char-token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`

### Current Authenticated User
- **`GET /api/v1/auth/me`** (200 OK)
  Requires `giga_session` cookie.
  Response:
  ```json
  {
    "user": {
      "id": "1e86a032-4166-4e5a-939e-e31b798782a2",
      "email": "user@example.com",
      "displayName": "Test User",
      "createdAt": "2026-10-13T03:45:00.000Z"
    }
  }
  ```

### Logout
- **`POST /api/v1/auth/logout`** (204 No Content)
  Revokes session token in database and sets `Max-Age=0` on `giga_session` cookie.

---

## 7. Security Invariants & Limitations

- **Argon2id Password Hashing:** Passwords are never stored in plaintext and never returned in API responses.
- **Session Token Hashing:** Raw session tokens are never stored in the database. PostgreSQL stores SHA-256 hashes only.
- **Fail-Closed CSRF Protection:** State-changing HTTP methods (`POST`, `PUT`, `DELETE`, `PATCH`) to `/api/*` strictly enforce origin validation against `ALLOWED_ORIGINS`. Requests missing `Origin` (and `Referer`) are rejected with `403 FORBIDDEN`. Untrusted origins receive a static `Untrusted request origin` error message without reflecting untrusted input. Wildcard origins (`*`) are prohibited in production.
- **Test Database Isolation & Guardrails:** Integration tests enforce strict database safety verification (`validateTestDatabaseSafety`). Destructive truncation is restricted exclusively to dedicated test databases designated via `TEST_DATABASE_URL` under `NODE_ENV=test`. Connection URLs are redacted in all logs and error messages. Tests never execute cleanup against `DATABASE_URL`.
- **Account Enumeration Prevention:** Incorrect credentials and unknown email queries return an identical generic error message (`Invalid email or password`).
- **No Leaked Stack Traces:** All errors follow canonical JSON error shape (`{"error":{"code":"...","message":"..."}}`).
- **Cross-Origin / Cookie Deployment Gate:** The final decision between same-origin reverse proxy vs cross-site `SameSite=None; Secure` cookies remains pending real browser testing at the W2 cloud deployment gate.

## 8. Chat generation runtime (DRAFT)

With a database and authenticated session, POST
`/api/v1/conversations/:id/messages:stream` accepts `{content,modelId?}` and a required
`Idempotency-Key`. Inject `llmEngine` into `createApp` to enable generation with the
server alias `giga-chat-default`. No provider is configured by default: unconfigured
admission returns 503 and never falls back to a fake response. FakeProvider is test-only.

GET `/api/v1/conversations/:id/generations/:generationId` reconciles durable state after
refresh/disconnect without repeating the provider. Apply migrations through 006 with the existing
migration runner before enabling these routes. See the [DRAFT contract](../../docs/contracts/GIGACHAT_RUNTIME_API_V0.2.md)
and [verification/handoff](../../docs/evidence/17t-32-chat-runtime.md) for limits and review gates.

POST `/api/v1/conversations/:id/generations/:generationId/cancel` accepts an empty body
and a distinct required `Idempotency-Key`. A 202 `{generation}` confirms durable intent;
200 reconciles an already-terminal generation. The original stream emits `message.stopped`
when Stop wins and delivery is available; GET reconciles after disconnect. Connection
abort alone remains `interrupted`. Keys cannot switch prompt/cancel operation or generation.
Immediate provider abort is local to the owning coordinator; remote cancellation uses DB
fencing and checkpointed partial text. See the [Stop candidate](../../docs/contracts/GIGACHAT_RUNTIME_API_V0.2.md#durable-stop-implementation-candidate--17t-34)
and [cancel handoff](../../docs/evidence/17t-34-chat-cancel.md). API v1 remains DRAFT.


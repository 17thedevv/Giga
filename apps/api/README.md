# Giga API

**Purpose:** Giga's TypeScript backend service built with Node.js and Hono, providing HTTP endpoints, streaming AI Chat, coding-agent orchestration, persistence and cloud health/operations.

> **Status:** Runnable backend scaffold (Task 17T-10). Node.js, Hono and strict TypeScript serve as the provisional stack. The API Contract remains **DRAFT** until joint freeze at the W1/W2 gate.

## Architecture and boundaries

- `src/app/`: Application bootstrap, HTTP adapters, configuration, and app factory (`createApp`) separated from network socket binding (`startServer`).
- `src/modules/auth/`: Authentication/session logic and account policy *(planned)*.
- `src/modules/conversations/`: Conversation and message operations *(planned)*.
- `src/modules/agent/`: Bounded agent run lifecycle and approvals *(planned)*.
- `src/integrations/llm/`: Remote model/provider adapters *(planned)*.
- `src/integrations/github/`: GitHub API tools with least-privilege access *(planned)*.
- `src/db/`: Persistence adapter and reviewed migrations *(planned)*.
- `tests/`: Unit and integration test suites.

## Getting started

All commands should be executed inside `apps/api`:

```bash
cd apps/api
```

### Prerequisites

- Node.js >= 20 (recommended: Node.js 22 LTS or 24)
- npm >= 10

### Installation

```bash
npm ci
```

### Development

Run the development server with live reload:

```bash
npm run dev
```

### Typecheck

Run strict TypeScript typechecking without emitting files:

```bash
npm run typecheck
```

### Build

Compile TypeScript source files into `dist/`:

```bash
npm run build
```

### Start production server

Start the compiled service from `dist/`:

```bash
npm start
```

### Tests

Execute automated unit and integration tests:

```bash
npm test
```

## Configuration

Configuration is managed via environment variables and loaded with fail-fast validation in `src/app/config.ts`:

| Variable | Type | Default | Description |
|---|---|---|---|
| `PORT` | Integer (1–65535) | `3000` | HTTP port for the network socket. Fails fast at startup if non-numeric, floating point, or outside 1–65535. |

## Current endpoints

- `GET /health` — Returns HTTP 200 with status JSON (`{"status":"ok","service":"giga-api","timestamp":"..."}`). Safe and lightweight with zero credentials exposed.
- Unknown routes return HTTP 404 with structured error shape (`{"error":{"code":"NOT_FOUND","message":"Route not found"}}`).

## Security invariants

- Never expose provider tokens, database credentials, or secret keys to clients or logs.
- Never output stack traces, sensitive system information, or internal error objects in HTTP responses.
- Enforce strict input validation on all future request boundaries.

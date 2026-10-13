# Giga — Web API Mock Fixtures

> **Purpose:** Mock request, response, and Server-Sent Events (SSE) data for the Giga Web Frontend (`apps/web`).  
> **Status:** Alignment with `docs/contracts/API_CONTRACT_V0.1.md` (DRAFT).  
> **Author:** Tráng A Thư (Frontend / UX) · **Reviewer:** Trà (Backend / API)

---

## 1. Directory Structure

```text
apps/web/mocks/
├── README.md                          # Usage guidelines and architecture
├── auth/                              # Authentication & Session payloads
│   ├── login-request.json
│   ├── login-response-200.json
│   ├── login-error-401.json
│   ├── me-response-200.json
│   ├── me-error-401.json
│   ├── logout-response-204.json
│   ├── register-request.json
│   ├── register-response-201.json
│   └── register-error-422.json
├── conversations/                     # Conversations & message history
│   ├── list-conversations-200.json
│   ├── list-conversations-empty-200.json
│   ├── create-conversation-request.json
│   ├── create-conversation-response-201.json
│   ├── get-conversation-detail-200.json
│   ├── get-conversation-404.json
│   └── delete-conversation-response-204.json
├── chat/                              # Chat streaming & error scenarios
│   ├── send-message-request.json
│   ├── chat-stream.sse                # Normal SSE chunk stream
│   ├── chat-stream-error.sse          # Mid-stream error event
│   ├── chat-conflict-409.json         # Concurrent generation error
│   └── chat-ratelimit-429.json        # Rate limiting payload
└── agent/                             # Autonomous coding agent lifecycle
    ├── create-run-request.json
    ├── create-run-response-201.json
    ├── create-run-error-400.json
    ├── run-queued-200.json
    ├── run-running-200.json
    ├── run-awaiting-approval-200.json
    ├── run-applying-200.json
    ├── run-completed-200.json
    ├── run-failed-200.json
    ├── run-cancelled-200.json
    ├── agent-events.sse               # Full lifecycle SSE event stream
    ├── agent-events-failed.sse        # Tool failure / agent limit event stream
    ├── proposal-detail-200.json       # Multi-file unified diff proposal
    ├── proposal-not-ready-404.json
    ├── decision-approve-request.json
    ├── decision-reject-request.json
    ├── decision-response-202.json
    ├── decision-stale-proposal-409.json
    ├── decision-duplicate-409.json
    └── cancel-run-response-202.json
```

---

## 2. How to Use These Fixtures

### A. Local Development with MSW (Mock Service Worker)
When developing the UI shell before the backend is deployed, configure an MSW handler to return these fixtures:

```typescript
import { http, HttpResponse } from 'msw';
import listConversations from '../mocks/conversations/list-conversations-200.json';
import me200 from '../mocks/auth/me-response-200.json';

export const handlers = [
  http.get('/api/v1/auth/me', () => HttpResponse.json(me200)),
  http.get('/api/v1/conversations', () => HttpResponse.json(listConversations)),
];
```

### B. Testing SSE Streaming via Mock Fetch / Vite Dev Server
The `.sse` files contain valid Server-Sent Events framing (`event: ...\ndata: ...\n\n`). You can stream them with a custom dev server or lightweight readable stream helper:

```typescript
export function streamMockFile(sseContent: string, onChunk: (line: string) => void) {
  const lines = sseContent.split('\n\n');
  lines.forEach((eventChunk, idx) => {
    setTimeout(() => onChunk(eventChunk), idx * 250);
  });
}
```

### C. Contract Verification & Parity Testing
During CI tests, verify that `apps/api` route outputs strictly adhere to the schemas defined in these fixtures. If the backend changes its response envelope, update both the API Contract and these fixtures via a reviewed Pull Request.

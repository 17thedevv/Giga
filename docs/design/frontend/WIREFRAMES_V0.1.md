# Giga — Frontend Wireframes Blueprint v0.1

> **Status:** DRAFT / PROPOSED · **Date:** 2026-10-13  
> **Author:** Tráng A Thư (Frontend / UX)  
> **Reviewer:** Trà (Backend / API)  
> **Linear Issue:** [17T-9](https://linear.app/17thedev/issue/17T-9/w1-ux-flows-wireframes-va-api-mocks)  
> **Companion Documents:** [UX Flow Blueprint](UX_FLOW_V0.1.md) · [API Mapping Spec](API_MAPPING_V0.1.md) · [API Contract v0.1](../../contracts/API_CONTRACT_V0.1.md)

---

## 1. Design System & Visual Tokens

Giga employs a **purpose-built, high-density developer interface** engineered for clarity, performance, and ergonomic multi-pane multitasking. It explicitly avoids visual mimicry of consumer chatbots like ChatGPT.

### Typography
- **UI Body & Headings:** Inter / System Sans-serif (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`)
- **Code & Diff & Logs:** JetBrains Mono / Fira Code / Monospace (`"JetBrains Mono", "Fira Code", monospace`)

### Color System & Status Semantics
- **Backgrounds:** Slate-950 (`#090d16` Deep Obsidian), Slate-900 (`#0f172a` Surface), Slate-800 (`#1e293b` Card/Border)
- **Foregrounds:** Slate-100 (`#f1f5f9` Primary Text), Slate-400 (`#94a3b8` Muted/Helper Text)
- **Primary / Brand Accent:** Indigo-500 (`#6366f1`) to Cyan-500 (`#06b6d4`)
- **Agent Status Semantics:**
  - `queued`: Gray-400 (`#9ca3af`)
  - `running`: Cyan-400 (`#22d3ee`) with subtle pulse animation
  - `awaiting_approval`: Amber-400 (`#fbbf24`) with highlight border
  - `applying`: Purple-400 (`#c084fc`) with indeterminate spinner
  - `completed`: Emerald-400 (`#34d399`) with solid badge
  - `failed`: Rose-500 (`#f43f5e`) with diagnostic alert container
  - `cancelled`: Slate-400 (`#94a3b8`) with neutral badge

---

## 2. Screen 1: Authentication (`/login`)

### Desktop Layout (1440px)

```text
+--------------------------------------------------------------------------------------------------+
| G I G A   [Cloud AI Chat & Coding Agent]                                           v0.1-draft   |
+--------------------------------------------------------------------------------------------------+
|                                                                                                  |
|                                       +-------------------------------+                          |
|                                       |           G I G A             |                          |
|                                       |     Developer Workspace       |                          |
|                                       +-------------------------------+                          |
|                                       |                               |                          |
|                                       | [!] Demo Environment Notice   |                          |
|                                       | Use assigned demo account.    |                          |
|                                       |                               |                          |
|                                       | Email Address                 |                          |
|                                       | [ user@demo.local           ] |                          |
|                                       |                               |                          |
|                                       | Password                      |                          |
|                                       | [ ******************       ] |                          |
|                                       |                               |                          |
|                                       | [x] Remember session (30d)    |                          |
|                                       |                               |                          |
|                                       | +---------------------------+ |                          |
|                                       | |   Sign In to Workspace    | |                          |
|                                       | +---------------------------+ |                          |
|                                       |                               |                          |
|                                       | Need credentials? Contact Trà |                          |
|                                       +-------------------------------+                          |
|                                                                                                  |
+--------------------------------------------------------------------------------------------------+
```

### Mobile Layout (375px)

```text
+---------------------------------------+
| G I G A                       [v0.1]  |
+---------------------------------------+
|                                       |
|  Sign In to Giga                      |
|  AI Chat & Coding Agent               |
|                                       |
|  [!] Demo accounts restricted to team |
|                                       |
|  Email                                |
|  [ user@demo.local                  ] |
|                                       |
|  Password                             |
|  [ ******************              ] |
|                                       |
|  +---------------------------------+  |
|  |           Sign In               |  |
|  +---------------------------------+  |
|                                       |
|  [x] Keep me signed in                |
|                                       |
+---------------------------------------+
```

### Key UI States for Auth:

```text
-- State: Submitting (Disabled + Spinner) -----------------------------------------------------------
   | [ @ Signing in...                                              ] |

-- State: 401 Unauthorized Error -------------------------------------------------------------------
   | [!] Invalid email or password. Please verify your credentials.   |

-- State: Session Expired Interceptor Modal --------------------------------------------------------
   +-------------------------------------------------------------------+
   |  Session Expired                                              [X] |
   |  Your session has timed out. Enter password to restore workspace: |
   |  Password: [ ****************** ]                                 |
   |  [ Cancel & Exit ]                 [ Re-authenticate (Keep Work) ]|
   +-------------------------------------------------------------------+
```

---

## 3. Screen 2: Multi-Turn AI Chat (`/chat` & `/chat/:id`)

### Desktop Layout (1440px)

```text
+------+-----------------------+-------------------------------------------------------------------+
| GIGA | Conversations    [+]  | Chat: Refactor Database Pool Connection               [Status: OK]|
+------+-----------------------+-------------------------------------------------------------------+
| [*]  | [Search chats...    ] | [AI Model: Default v0.1]                              [Clear] [.] |
| Chat |                       |-------------------------------------------------------------------|
|      | > Refactor DB Pool    | USER:                                                             |
| [<>] |   Active * 2m ago [x] | How do we ensure Neon PostgreSQL connections don't leak during    |
|Agent |                       | serverless cold starts in Hono?                                   |
|      | > Fix CORS headers    |                                                     10:42 AM      |
| [?]  |   Yesterday           |-------------------------------------------------------------------|
| Docs |                       | GIGA ASSISTANT:                                                   |
|      | > Setup Dockerfile    | In Hono with Neon serverless driver, you should use the `@neondat-|
|      |   12 Oct 2026         | abase/serverless` connection pooler over WebSockets:              |
|      |                       |                                                                   |
|      |                       | ```typescript                                                     |
|      |                       | import { Pool } from '@neondatabase/serverless';                  |
|      |                       | export const pool = new Pool({ connectionString: env.DATABASE_URL|
|      |                       | });                                                               |
|      |                       | ```                                               [Copy Code]     |
|      |                       |                                                                   |
|      |                       | This ensures persistent connections terminate gracefully when idle|
|      |                       | without exhausting free-tier pool quotas._                        |
|      |                       |                                                     10:42 AM      |
|      |-----------------------+-------------------------------------------------------------------|
|      | User: Tráng A Thư     | [!] Composer: Enter prompt (Markdown supported)...                |
| [U]  | thuthu@demo.local     | [ What is the best retry strategy for transient network errors? ] |
| User | [Sign Out]            | [ Attach Repo ] [ Model: v0.1-standard ]        [ Stop / Send > ] |
+------+-----------------------+-------------------------------------------------------------------+
```

### Mobile Layout (375px) — Chat View with Drawer Closed

```text
+---------------------------------------+
| [=] GIGA Chat                 [+ New] |
+---------------------------------------+
| USER (10:42):                         |
| How do we prevent connection leaks on |
| serverless cold starts?               |
|---------------------------------------|
| GIGA ASSISTANT (10:42):               |
| In Hono with Neon, initialize a       |
| pooled connection with idle timeout:  |
|                                       |
| ```ts                                 |
| const pool = new Pool({...});         |
| ```                     [Copy Code]   |
|                                       |
| Ensure `pool.end()` on teardown.      |
|---------------------------------------|
| [Type a message...                  ] |
| [ + ] [ Model: v0.1 ]       [ Send > ]|
+---------------------------------------+
```

### Key UI States for Chat:

```text
-- State: Active Streaming (Stop Action Active) -----------------------------------------------------
   | GIGA ASSISTANT: Generating solution... _ (blinking cursor)
   | [ Composer Input Disabled ]                     [ [Stop Generation] ]

-- State: Empty Conversation -----------------------------------------------------------------------
   |               Welcome to Giga Developer Chat
   |          Select a prompt below or ask your own question:
   |   [ Explain Git Invariants ]     [ Review Hono API Routes ]
   |   [ Analyze Docker Build ]       [ Create DB Migration ]

-- State: Stream Error / Connection Drop -----------------------------------------------------------
   | [!] Connection lost to stream server. (502 Upstream Gateway)
   |     Tokens received: 142. Last chunk retained.
   |     [ Retry from last message ]         [ Dismiss ]

-- State: Delete Conversation Confirmation Modal ---------------------------------------------------
   +-------------------------------------------------------------------+
   |  Delete Conversation?                                         [X] |
   |  This will permanently delete "Refactor DB Pool" and its messages.|
   |  This action cannot be undone.                                    |
   |                                                                   |
   |  [ Cancel ]                                 [ Delete Permanently ]|
   +-------------------------------------------------------------------+
```

---

## 4. Screen 3: Coding Agent Workspace (`/agent` & `/agent/runs/:id`)

### Desktop Layout (1440px) — Live Execution & Tool Timeline

```text
+------+-----------------------+-------------------------------------------------------------------+
| GIGA | Agent Runs       [+]  | Run #run_881a: Fix Connection Leak                [RUNNING *]     |
+------+-----------------------+-------------------------------------------------------------------+
| [*]  | > run_881a (running)  | Target: 17thedevv/Giga @ branch: main               [Cancel Run]  |
| Chat |   Fix DB leak * 1m    | Task: Investigate unclosed pg client handles in apps/api/src/db   |
|      |                       +-------------------------------------------------------------------+
| [<>] | > run_770b (completed| TIMELINE & TOOL EXECUTION:                                        |
|Agent |   Add CORS headers    |                                                                   |
|      |                       | [x] 10:44:01 | Tool: github_read_file (120ms)                     |
| [?]  | > run_652c (failed)   |     Target: apps/api/src/db/connection.ts                         |
| Docs |   Invalid syntax      |     [+] Arguments: { path: "apps/api/src/db/connection.ts" }     |
|      |                       |     [+] Output: 48 lines inspected. Leak found at line 34.        |
|      |                       |                                                                   |
|      |                       | [x] 10:44:03 | Tool: github_search_code (340ms)                   |
|      |                       |     Query: "new Pool(" across apps/api                            |
|      |                       |     [+] Output: 2 occurrences matched.                            |
|      |                       |                                                                   |
|      |                       | [@] 10:44:05 | Tool: github_prepare_diff (Running...)             |
|      |                       |     Generating patch against baseCommit: `4aff648`...             |
|      |                       |                                                                   |
|      |-----------------------+-------------------------------------------------------------------|
|      | User: Tráng A Thư     | LIVE LOG STREAM:                                                  |
| [U]  | [Settings]            | > [INFO] 10:44:01: Agent loop step 1 completed (1 tool invocation)|
| User | [Sign Out]            | > [INFO] 10:44:05: Synthesizing patch for human approval...       |
+------+-----------------------+-------------------------------------------------------------------+
```

### Mobile Layout (375px) — Compact Run Timeline

```text
+---------------------------------------+
| [=] GIGA Agent            [Cancel Run]|
+---------------------------------------+
| Run #run_881a             [RUNNING *] |
| Repo: 17thedevv/Giga (main)           |
| Task: Fix connection leaks in db      |
|---------------------------------------|
| EXECUTION STEPS:                      |
|                                       |
| [v] 1. Read connection.ts (120ms)     |
|     `apps/api/src/db/connection.ts`   |
|                                       |
| [v] 2. Search Code (340ms)            |
|     `new Pool(`                       |
|                                       |
| [@] 3. Preparing Patch...             |
|     Diff generation in progress       |
|---------------------------------------|
| Terminal Logs:                        |
| > 10:44:05 Step 2 complete.           |
+---------------------------------------+
```

### Run Creation Form Layout (`/agent`):

```text
+--------------------------------------------------------------------------------------------------+
| Launch Autonomous Coding Agent                                                                   |
+--------------------------------------------------------------------------------------------------+
| Target Repository:                                                                               |
| [ 17thedevv/Giga                                                                            [v] ]|
|                                                                                                  |
| Base Branch / Reference:                                                                         |
| [ main                                                                                         ] |
|                                                                                                  |
| Task Instruction & Requirements:                                                                 |
| +----------------------------------------------------------------------------------------------+ |
| | Refactor Neon database client pool initialization in apps/api/src/db/client.ts.               | |
| | Ensure connection error events are caught and connections closed on process SIGTERM.         | |
| |                                                                                              | |
| +----------------------------------------------------------------------------------------------+ |
|                                                                                                  |
| Safety Policy: Agent will run read-only tools until diff proposal is approved by you.            |
| [ Cancel ]                                                                [ Launch Agent Run > ] |
+--------------------------------------------------------------------------------------------------+
```

---

## 5. Screen 4: Diff Inspection & Approval Gate (`/agent/runs/:id/proposal`)

### Desktop Layout (1440px) — Side-by-Side Review & Action Bar

```text
+------+-------------------------------------------------------------------------------------------+
| GIGA | Run #run_881a: Change Proposal Ready                         [AWAITING YOUR APPROVAL *]  |
+------+-------------------------------------------------------------------------------------------+
| [<]  | Base Commit: `4aff648`  |  Files Changed: 2  |  Additions: +18  |  Deletions: -6           |
| Back +------------------------------------+------------------------------------------------------+
|      | CHANGED FILES                      | DIFF VIEWER: apps/api/src/db/client.ts               |
|      |------------------------------------|------------------------------------------------------|
|      | > [M] apps/api/src/db/client.ts    | @@ -32,8 +32,14 @@ export function createDbClient()  |
|      |       (+12, -6)                    |    32    32    const pool = new Pool({               |
|      |                                    |    33    33      connectionString: env.DATABASE_URL, |
|      |   [A] apps/api/tests/db.test.ts    | -  34          - max: 20                             |
|      |       (+6, -0)                     | +        34    + max: 10,                            |
|      |                                    | +        35    + idleTimeoutMillis: 30000            |
|      |                                    |    36    36    });                                   |
|      |                                    | +        37  + pool.on('error', (err) => {           |
|      |                                    | +        38  +   logger.error('DB pool error', err); |
|      |                                    | +        39  + });                                   |
|      |                                    |    40    40    return pool;                          |
|      |------------------------------------+------------------------------------------------------|
|      | ACTION BAR (Strict Human Gate):                                                           |
|      | This action will create a branch & Pull Request on 17thedevv/Giga under your credentials. |
|      |                                                                                           |
|      | [ Reject Proposal ]                           [ Approve & Open Pull Request (Emerald) ]  |
+------+-------------------------------------------------------------------------------------------+
```

### Mobile Layout (375px) — Diff Viewer & Action Bar

```text
+---------------------------------------+
| [<] Proposal Review      [AWAITING *] |
| Repo: 17thedevv/Giga (2 files, +18/-6)|
+---------------------------------------+
| Files: [M] client.ts  [A] db.test.ts  |
|---------------------------------------|
| @@ -32,8 +32,14 @@ client.ts           |
|  32  const pool = new Pool({          |
|  33    connectionString: env.DB_URL,  |
| -34  - max: 20                        |
| +34  + max: 10,                       |
| +35  + idleTimeoutMillis: 30000       |
|  36  });                              |
| +37  + pool.on('error', handleErr);   |
|---------------------------------------|
| Strict Review Action:                 |
| [ Reject ]       [ Approve & Open PR ]|
+---------------------------------------+
```

### Approval Lifecycle Modals & State Overlays:

#### 1. Confirmation Modal (Before Submitting)
```text
+-------------------------------------------------------------------------------+
|  Confirm Remote Write Action                                              [X] |
+-------------------------------------------------------------------------------+
|  Target:     github.com/17thedevv/Giga                                        |
|  Branch:     agent/fix-db-leak-881a                                           |
|  Base SHA:   4aff648                                                          |
|  Summary:    2 files modified (+18, -6)                                       |
|                                                                               |
|  [!] Once approved, the Giga server will commit changes and create a Pull     |
|      Request. This operation cannot be undone.                                |
|                                                                               |
|  [ Cancel / Return to Diff ]             [ Confirm & Proceed with Write ]     |
+-------------------------------------------------------------------------------+
```

#### 2. "Applying" State (Buttons Disabled, Indeterminate Spinner)
```text
+-------------------------------------------------------------------------------+
|  STATUS: APPLYING CHANGES TO GITHUB...                                        |
|  [ @ Applying patch to remote repository and opening Pull Request... ]        |
|  Please do not close or refresh this tab. Actions temporarily locked.        |
|  [ Disabled: Reject ]                      [ Disabled: Approve & Open PR ]    |
+-------------------------------------------------------------------------------+
```

#### 3. "Completed" State (PR Created Confirmed by Server)
```text
+-------------------------------------------------------------------------------+
|  [v] PULL REQUEST CREATED SUCCESSFULLY                                        |
|  Pull Request #12 has been opened on 17thedevv/Giga:                          |
|  URL: https://github.com/17thedevv/Giga/pull/12             [ Copy Link ]     |
|                                                                               |
|  [ Open PR on GitHub -> ]                           [ Start New Agent Task ]  |
+-------------------------------------------------------------------------------+
```

#### 4. "Stale Proposal" Error State (409 Conflict)
```text
+-------------------------------------------------------------------------------+
|  [!] PROPOSAL IS STALE (CONFLICT 409)                                         |
|  The base commit on `main` (current: e1b4a90) has advanced since this diff    |
|  was generated (base: 4aff648). To prevent merge conflicts, this proposal     |
|  cannot be applied.                                                           |
|                                                                               |
|  [ View Diff (Read-Only) ]                [ Run New Agent Task on Latest ]    |
+-------------------------------------------------------------------------------+
```

---

## 6. Interaction Matrix & Accessibility Annotations

| Component | Target Size | Tab Order | Focus Ring | ARIA Attributes |
|---|---|---|---|---|
| **Mode Switcher (Chat/Agent)** | 48x48px | 1 | 2px solid `#6366f1` | `role="tab"`, `aria-selected="true/false"` |
| **New Chat / New Run Button** | 36px height | 2 | 2px solid `#6366f1` | `role="button"`, `aria-label="Create new conversation"` |
| **Search Input** | 36px height | 3 | 2px solid `#6366f1` | `role="searchbox"`, `aria-label="Filter conversations"` |
| **Conversation Item** | 44px height | 4 | 2px solid `#6366f1` | `role="link"`, `aria-current="page"` (if active) |
| **Delete Conversation Icon** | 32x32px | 5 | 2px solid `#f43f5e` | `role="button"`, `aria-label="Delete conversation: [title]"` |
| **Chat Composer Textarea** | min 48px | 6 | 2px solid `#6366f1` | `role="textbox"`, `aria-multiline="true"`, `aria-label="Message prompt"` |
| **Send / Stop Button** | 36x36px | 7 | 2px solid `#6366f1` | `role="button"`, `aria-label="Send message" / "Stop generating"` |
| **Tool Step Accordion Header**| 40px height | 8 | 2px solid `#6366f1` | `role="button"`, `aria-expanded="true/false"` |
| **Diff File Tab** | 36px height | 9 | 2px solid `#6366f1` | `role="tab"`, `aria-selected="true/false"` |
| **Approve Button** | 44px height | 10 | 2px solid `#34d399` | `role="button"`, `aria-label="Approve proposal and open Pull Request"` |
| **Reject Button** | 44px height | 11 | 2px solid `#f43f5e` | `role="button"`, `aria-label="Reject proposal"` |

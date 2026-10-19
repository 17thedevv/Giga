import type {
  AgentWorkspace,
  AgentRun,
  AgentMode,
  AgentStatus,
  VerifiedCheck,
} from '../../lib/api/agent-contract.js';

export interface PlanStep {
  readonly id: string;
  readonly stepNumber: number;
  readonly title: string;
  readonly description: string;
  readonly status: 'completed' | 'running' | 'pending' | 'failed';
}

export interface TimelineEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly category: string;
  readonly label: string;
  readonly detail?: string;
  readonly status: 'completed' | 'running' | 'pending' | 'failed';
  readonly durationMs?: number;
}

export interface WorkspaceFileChange {
  readonly path: string;
  readonly status: 'created' | 'modified' | 'deleted';
  readonly additions?: number;
  readonly deletions?: number;
  readonly diffPreview?: string;
}

export interface AgentArtifactItem {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly size: string;
  readonly isDemo: true;
  readonly summary: string;
}

export interface ExternalApprovalRequest {
  readonly id: string;
  readonly action: string;
  readonly target: string;
  readonly risk: 'low' | 'medium' | 'high';
  readonly reason: string;
  readonly scope: string;
  readonly sideEffects: string;
  readonly status: 'pending' | 'approved' | 'rejected';
}

export interface AgentRunDetail extends AgentRun {
  readonly workspaceName: string;
  readonly plan: readonly PlanStep[];
  readonly timeline: readonly TimelineEvent[];
  readonly fileChanges: readonly WorkspaceFileChange[];
  readonly verifications: readonly VerifiedCheck[];
  readonly artifacts: readonly AgentArtifactItem[];
  readonly approvalRequest?: ExternalApprovalRequest;
  readonly isDemo: boolean;
}

// Initial Workspaces
const INITIAL_WORKSPACES: AgentWorkspace[] = [
  {
    id: 'ws-react-task-manager',
    name: 'React Task Manager',
    sourceKind: 'blank',
    revision: 1,
    createdAt: '2026-10-18T08:00:00.000Z',
    updatedAt: '2026-10-18T08:30:00.000Z',
  },
  {
    id: 'ws-csv-analytics',
    name: 'CSV Dataset Analytics',
    sourceKind: 'blank',
    revision: 1,
    createdAt: '2026-10-17T14:00:00.000Z',
    updatedAt: '2026-10-17T14:45:00.000Z',
  },
  {
    id: 'ws-doc-site',
    name: 'Documentation Website',
    sourceKind: 'blank',
    revision: 1,
    createdAt: '2026-10-16T10:00:00.000Z',
    updatedAt: '2026-10-16T11:20:00.000Z',
  },
];

// Initial Deterministic Run Fixtures
const GOLDEN_REACT_RUN: AgentRunDetail = {
  id: 'run-golden-react',
  workspaceId: 'ws-react-task-manager',
  workspaceName: 'React Task Manager',
  task: 'Build a responsive React task manager with add, edit, complete and delete functionality.',
  mode: 'execute',
  runtime: 'cloud',
  modelId: 'giga-agent-default',
  status: 'completed',
  phase: 'verifying',
  createdAt: '2026-10-18T08:00:00.000Z',
  updatedAt: '2026-10-18T08:04:12.000Z',
  finishedAt: '2026-10-18T08:04:12.000Z',
  isDemo: true,
  result: {
    summary: 'Successfully created responsive React task manager, verified TypeScript compilation, executed unit tests, and prepared production bundle.',
    artifactIds: ['art-react-src', 'art-build-summary'],
    verifiedChecks: [
      { name: 'TypeScript Typecheck', outcome: 'passed', summary: 'tsc --noEmit: 0 type errors found.' },
      { name: 'Production Build', outcome: 'passed', summary: 'vite build: production bundle compiled in 340ms.' },
      { name: 'Unit Tests', outcome: 'passed', summary: 'vitest run: 12 tests passed, 0 failures.' },
    ],
  },
  plan: [
    {
      id: 'step-1',
      stepNumber: 1,
      title: 'Understand requirements',
      description: 'Analyze task requirements for responsive layout, CRUD operations and state handling.',
      status: 'completed',
    },
    {
      id: 'step-2',
      stepNumber: 2,
      title: 'Inspect workspace',
      description: 'Inspect blank workspace directory structure, package dependencies and configuration.',
      status: 'completed',
    },
    {
      id: 'step-3',
      stepNumber: 3,
      title: 'Create implementation',
      description: 'Write React component files, state reducers, task filtering and responsive styling.',
      status: 'completed',
    },
    {
      id: 'step-4',
      stepNumber: 4,
      title: 'Run verification',
      description: 'Run TypeScript typecheck, production build, and unit test suite inside isolated sandbox.',
      status: 'completed',
    },
    {
      id: 'step-5',
      stepNumber: 5,
      title: 'Produce results',
      description: 'Package source project bundle and generate verification evidence report.',
      status: 'completed',
    },
  ],
  timeline: [
    {
      id: 'evt-1',
      timestamp: '08:00:05',
      category: 'Plan created',
      label: 'Formulated 5-step structured execution plan',
      status: 'completed',
      durationMs: 420,
    },
    {
      id: 'evt-2',
      timestamp: '08:00:32',
      category: 'Inspect workspace',
      label: 'Read directory root and package.json manifest',
      detail: 'Verified React 18, TypeScript, and Vite toolchain configuration.',
      status: 'completed',
      durationMs: 280,
    },
    {
      id: 'evt-3',
      timestamp: '08:01:15',
      category: 'Write file',
      label: 'Created src/App.tsx with task manager layout and state hooks',
      detail: 'Added TaskProvider context, task list container, and modal controls.',
      status: 'completed',
      durationMs: 650,
    },
    {
      id: 'evt-4',
      timestamp: '08:01:45',
      category: 'Write file',
      label: 'Created src/components/TaskList.tsx and TaskItem.tsx',
      detail: 'Implemented task items with checkbox toggle, inline editing, and deletion.',
      status: 'completed',
      durationMs: 580,
    },
    {
      id: 'evt-5',
      timestamp: '08:02:10',
      category: 'Write file',
      label: 'Created src/styles.css with responsive modern dark theme',
      status: 'completed',
      durationMs: 310,
    },
    {
      id: 'evt-6',
      timestamp: '08:02:40',
      category: 'Run sandbox command',
      label: 'Executed npm run typecheck in isolated sandbox',
      detail: 'TypeScript compiler emitted 0 diagnostics.',
      status: 'completed',
      durationMs: 1420,
    },
    {
      id: 'evt-7',
      timestamp: '08:03:15',
      category: 'Run tests',
      label: 'Executed vitest run in sandbox runtime',
      detail: '12 unit tests passed (CRUD actions, filter logic, localStorage sync).',
      status: 'completed',
      durationMs: 2150,
    },
    {
      id: 'evt-8',
      timestamp: '08:03:50',
      category: 'Run build',
      label: 'Executed vite build for production preview',
      detail: 'Bundle size: 142 KB JS, 18 KB CSS.',
      status: 'completed',
      durationMs: 840,
    },
    {
      id: 'evt-9',
      timestamp: '08:04:10',
      category: 'Artifact prepared',
      label: 'Packaged react-task-manager-src.zip and verification evidence report',
      status: 'completed',
      durationMs: 190,
    },
  ],
  fileChanges: [
    {
      path: 'src/App.tsx',
      status: 'created',
      additions: 85,
      deletions: 0,
      diffPreview: '@@ -0,0 +1,85 @@\n+import React, { useState } from "react";\n+import { TaskList } from "./components/TaskList";\n+export function App() { ... }',
    },
    {
      path: 'src/components/TaskList.tsx',
      status: 'created',
      additions: 64,
      deletions: 0,
      diffPreview: '@@ -0,0 +1,64 @@\n+import React from "react";\n+export const TaskList: React.FC = () => { ... }',
    },
    {
      path: 'src/styles.css',
      status: 'created',
      additions: 48,
      deletions: 0,
      diffPreview: '@@ -0,0 +1,48 @@\n+:root { --giga-bg: #0B1220; }\n+.task-card { border-radius: 8px; }',
    },
    {
      path: 'package.json',
      status: 'modified',
      additions: 6,
      deletions: 1,
      diffPreview: '@@ -12,4 +12,9 @@\n   "scripts": {\n+    "test": "vitest run"\n   }',
    },
  ],
  verifications: [
    { name: 'TypeScript Typecheck', outcome: 'passed', summary: 'tsc --noEmit: 0 type errors found.' },
    { name: 'Production Build', outcome: 'passed', summary: 'vite build: production bundle compiled in 340ms.' },
    { name: 'Unit Tests', outcome: 'passed', summary: 'vitest run: 12 tests passed, 0 failures.' },
  ],
  artifacts: [
    {
      id: 'art-react-src',
      name: 'react-task-manager-src.zip',
      type: 'Source Project (ZIP)',
      size: '42.8 KB',
      isDemo: true,
      summary: 'Complete source bundle for responsive React task manager application.',
    },
    {
      id: 'art-build-summary',
      name: 'build-summary.md',
      type: 'Verification Report',
      size: '3.2 KB',
      isDemo: true,
      summary: 'Automated test results, TypeScript verification log, and asset breakdown.',
    },
  ],
};

const ASK_MODE_RUN: AgentRunDetail = {
  id: 'run-ask-demo',
  workspaceId: 'ws-react-task-manager',
  workspaceName: 'React Task Manager',
  task: 'Explain how React state batching works in concurrent mode.',
  mode: 'ask',
  runtime: 'cloud',
  modelId: 'giga-agent-default',
  status: 'completed',
  createdAt: '2026-10-18T09:00:00.000Z',
  updatedAt: '2026-10-18T09:01:10.000Z',
  finishedAt: '2026-10-18T09:01:10.000Z',
  isDemo: true,
  result: {
    summary: 'Analyzed question and provided detailed technical explanation of automatic batching in React 18 concurrent features.',
    artifactIds: [],
    verifiedChecks: [],
  },
  plan: [
    {
      id: 'ask-step-1',
      stepNumber: 1,
      title: 'Analyze question context',
      description: 'Review React 18 event batching semantics across asynchronous boundaries.',
      status: 'completed',
    },
    {
      id: 'ask-step-2',
      stepNumber: 2,
      title: 'Synthesize explanation',
      description: 'Formulate structured technical response with code examples and flushSync nuances.',
      status: 'completed',
    },
  ],
  timeline: [
    {
      id: 'ask-evt-1',
      timestamp: '09:00:08',
      category: 'Plan created',
      label: 'Identified core architectural concepts',
      status: 'completed',
      durationMs: 250,
    },
    {
      id: 'ask-evt-2',
      timestamp: '09:00:45',
      category: 'Inspect workspace',
      label: 'Verified React version in project dependencies (React 18.2.0)',
      status: 'completed',
      durationMs: 180,
    },
    {
      id: 'ask-evt-3',
      timestamp: '09:01:05',
      category: 'Verify result',
      label: 'Delivered response to user',
      detail: 'Ask mode completed without workspace file modifications.',
      status: 'completed',
      durationMs: 120,
    },
  ],
  fileChanges: [],
  verifications: [],
  artifacts: [],
};

const PLAN_MODE_RUN: AgentRunDetail = {
  id: 'run-plan-demo',
  workspaceId: 'ws-csv-analytics',
  workspaceName: 'CSV Dataset Analytics',
  task: 'Plan an architecture migration from REST to GraphQL for analytics queries.',
  mode: 'plan',
  runtime: 'cloud',
  modelId: 'giga-agent-default',
  status: 'completed',
  createdAt: '2026-10-17T15:00:00.000Z',
  updatedAt: '2026-10-17T15:02:40.000Z',
  finishedAt: '2026-10-17T15:02:40.000Z',
  isDemo: true,
  result: {
    summary: 'Formulated 4-phase architectural migration plan for GraphQL query layer with zero downtime.',
    artifactIds: [],
    verifiedChecks: [],
  },
  plan: [
    {
      id: 'plan-step-1',
      stepNumber: 1,
      title: 'Audit existing REST endpoints',
      description: 'Inventory query shapes, payload sizes, and caching headers.',
      status: 'completed',
    },
    {
      id: 'plan-step-2',
      stepNumber: 2,
      title: 'Draft GraphQL schema design',
      description: 'Define type definitions, resolvers, and DataLoader batching strategies.',
      status: 'completed',
    },
    {
      id: 'plan-step-3',
      stepNumber: 3,
      title: 'Define verification & rollout strategy',
      description: 'Specify dual-read verification, schema deprecation and performance benchmarks.',
      status: 'completed',
    },
  ],
  timeline: [
    {
      id: 'plan-evt-1',
      timestamp: '15:00:10',
      category: 'Plan created',
      label: 'Initiated architectural planning process',
      status: 'completed',
      durationMs: 310,
    },
    {
      id: 'plan-evt-2',
      timestamp: '15:01:20',
      category: 'Inspect workspace',
      label: 'Examined current API client endpoints and response contracts',
      status: 'completed',
      durationMs: 440,
    },
    {
      id: 'plan-evt-3',
      timestamp: '15:02:30',
      category: 'Verify result',
      label: 'Completed architectural migration plan',
      detail: 'Plan mode completed without workspace file modifications.',
      status: 'completed',
      durationMs: 150,
    },
  ],
  fileChanges: [],
  verifications: [],
  artifacts: [],
};

const FAILED_RUN: AgentRunDetail = {
  id: 'run-failed-demo',
  workspaceId: 'ws-react-task-manager',
  workspaceName: 'React Task Manager',
  task: 'Refactor data access layer to Prisma with SQLite.',
  mode: 'execute',
  runtime: 'cloud',
  modelId: 'giga-agent-default',
  status: 'failed',
  phase: 'verifying',
  createdAt: '2026-10-18T10:00:00.000Z',
  updatedAt: '2026-10-18T10:02:15.000Z',
  finishedAt: '2026-10-18T10:02:15.000Z',
  error: {
    code: 'VERIFICATION_FAILED',
    message: 'Sandbox build failed with 3 TypeScript compilation errors in prisma/client.ts.',
  },
  isDemo: true,
  result: {
    summary: 'Execution halted: verification checks failed after retry limit exceeded.',
    artifactIds: [],
    verifiedChecks: [
      { name: 'TypeScript Typecheck', outcome: 'failed', summary: 'tsc --noEmit failed with 3 errors (Type "string" is not assignable to type "number").' },
      { name: 'Production Build', outcome: 'not_run', summary: 'Build skipped due to compile errors.' },
      { name: 'Unit Tests', outcome: 'not_run', summary: 'Tests skipped due to compile errors.' },
    ],
  },
  plan: [
    {
      id: 'fail-step-1',
      stepNumber: 1,
      title: 'Install Prisma dependencies',
      description: 'Add prisma and @prisma/client packages.',
      status: 'completed',
    },
    {
      id: 'fail-step-2',
      stepNumber: 2,
      title: 'Create schema & client',
      description: 'Generate database client and migration scripts.',
      status: 'completed',
    },
    {
      id: 'fail-step-3',
      stepNumber: 3,
      title: 'Run verification tests',
      description: 'Validate schema types and run build.',
      status: 'failed',
    },
  ],
  timeline: [
    {
      id: 'fail-evt-1',
      timestamp: '10:00:05',
      category: 'Plan created',
      label: 'Planned Prisma integration steps',
      status: 'completed',
      durationMs: 300,
    },
    {
      id: 'fail-evt-2',
      timestamp: '10:00:45',
      category: 'Write file',
      label: 'Created prisma/schema.prisma and src/lib/db.ts',
      status: 'completed',
      durationMs: 520,
    },
    {
      id: 'fail-evt-3',
      timestamp: '10:01:40',
      category: 'Run build',
      label: 'Executed tsc --noEmit: compile failure detected',
      detail: '3 TypeScript errors in prisma/client.ts: property id mismatch.',
      status: 'failed',
      durationMs: 1820,
    },
  ],
  fileChanges: [
    {
      path: 'prisma/schema.prisma',
      status: 'created',
      additions: 24,
      deletions: 0,
      diffPreview: '@@ -0,0 +1,24 @@\n+datasource db { provider = "sqlite" url = env("DATABASE_URL") }\n+model Task { id Int @id @default(autoincrement()) title String }',
    },
    {
      path: 'src/lib/db.ts',
      status: 'created',
      additions: 18,
      deletions: 0,
      diffPreview: '@@ -0,0 +1,18 @@\n+import { PrismaClient } from "@prisma/client";\n+export const prisma = new PrismaClient();',
    },
  ],
  verifications: [
    { name: 'TypeScript Typecheck', outcome: 'failed', summary: 'tsc --noEmit failed with 3 errors.' },
    { name: 'Production Build', outcome: 'not_run', summary: 'Build skipped due to compile errors.' },
    { name: 'Unit Tests', outcome: 'not_run', summary: 'Tests skipped due to compile errors.' },
  ],
  artifacts: [],
};

const CANCELLED_RUN: AgentRunDetail = {
  id: 'run-cancelled-demo',
  workspaceId: 'ws-csv-analytics',
  workspaceName: 'CSV Dataset Analytics',
  task: 'Analyze massive dataset and generate multi-dimensional distribution charts.',
  mode: 'execute',
  runtime: 'cloud',
  modelId: 'giga-agent-default',
  status: 'cancelled',
  createdAt: '2026-10-17T16:00:00.000Z',
  updatedAt: '2026-10-17T16:01:30.000Z',
  finishedAt: '2026-10-17T16:01:30.000Z',
  error: {
    code: 'CANCELLED',
    message: 'Run was cancelled by user request. Sandbox execution terminated safely.',
  },
  isDemo: true,
  result: {
    summary: 'Run cancelled by user. Partial sandbox changes preserved.',
    artifactIds: [],
    verifiedChecks: [],
  },
  plan: [
    {
      id: 'cancel-step-1',
      stepNumber: 1,
      title: 'Parse CSV files',
      description: 'Stream CSV data and validate column schemas.',
      status: 'completed',
    },
    {
      id: 'cancel-step-2',
      stepNumber: 2,
      title: 'Compute statistical aggregates',
      description: 'Compute percentiles and correlation matrix.',
      status: 'failed',
    },
  ],
  timeline: [
    {
      id: 'cancel-evt-1',
      timestamp: '16:00:08',
      category: 'Plan created',
      label: 'Generated analysis execution plan',
      status: 'completed',
    },
    {
      id: 'cancel-evt-2',
      timestamp: '16:00:45',
      category: 'Read file',
      label: 'Read dataset headers from input.csv',
      status: 'completed',
    },
    {
      id: 'cancel-evt-3',
      timestamp: '16:01:30',
      category: 'Task cancelled',
      label: 'User initiated cancellation. Processes terminated.',
      status: 'failed',
    },
  ],
  fileChanges: [
    {
      path: 'scripts/parse.py',
      status: 'created',
      additions: 32,
      deletions: 0,
    },
  ],
  verifications: [],
  artifacts: [],
};

const AWAITING_APPROVAL_RUN: AgentRunDetail = {
  id: 'run-approval-demo',
  workspaceId: 'ws-doc-site',
  workspaceName: 'Documentation Website',
  task: 'Deploy preview build to external staging environment.',
  mode: 'execute',
  runtime: 'cloud',
  modelId: 'giga-agent-default',
  status: 'awaiting_approval',
  phase: 'executing',
  createdAt: '2026-10-16T11:00:00.000Z',
  updatedAt: '2026-10-16T11:02:40.000Z',
  isDemo: true,
  result: undefined,
  plan: [
    {
      id: 'appr-step-1',
      stepNumber: 1,
      title: 'Build static documentation bundle',
      description: 'Compile markdown pages and assets into /dist.',
      status: 'completed',
    },
    {
      id: 'appr-step-2',
      stepNumber: 2,
      title: 'Verify HTML links and assets',
      description: 'Execute link checker and asset validator.',
      status: 'completed',
    },
    {
      id: 'appr-step-3',
      stepNumber: 3,
      title: 'Deploy to external staging host',
      description: 'Requires explicit human authorization for external network write.',
      status: 'running',
    },
  ],
  timeline: [
    {
      id: 'appr-evt-1',
      timestamp: '11:00:10',
      category: 'Plan created',
      label: 'Created deployment plan',
      status: 'completed',
    },
    {
      id: 'appr-evt-2',
      timestamp: '11:01:15',
      category: 'Run build',
      label: 'Built static documentation site in /dist',
      status: 'completed',
    },
    {
      id: 'appr-evt-3',
      timestamp: '11:02:40',
      category: 'Approval required',
      label: 'Halted before external deployment. Awaiting explicit user approval.',
      detail: 'External network egress to staging host https://staging-preview.giga.dev requires permission.',
      status: 'running',
    },
  ],
  fileChanges: [
    {
      path: 'dist/index.html',
      status: 'created',
      additions: 120,
      deletions: 0,
    },
    {
      path: 'dist/docs.json',
      status: 'created',
      additions: 45,
      deletions: 0,
    },
  ],
  verifications: [
    { name: 'Link Check', outcome: 'passed', summary: 'All 34 internal links verified.' },
  ],
  artifacts: [],
  approvalRequest: {
    id: 'appr-staging-deploy',
    action: 'Publish to External Staging Host',
    target: 'https://staging-preview.giga.dev/docs-v2',
    risk: 'high',
    reason: 'External network egress and publishing outside the isolated sandbox requires explicit human review.',
    scope: 'One-time HTTPS POST deployment of /dist assets to staging bucket.',
    sideEffects: 'Modifies live preview URL visible to external reviewers.',
    status: 'pending',
  },
};

// Initial Deterministic Run Fixtures
export const INITIAL_RUNS: readonly AgentRunDetail[] = [
  GOLDEN_REACT_RUN,
  ASK_MODE_RUN,
  PLAN_MODE_RUN,
  FAILED_RUN,
  CANCELLED_RUN,
  AWAITING_APPROVAL_RUN,
];

export const DEMO_STORAGE_KEY_WORKSPACES = 'giga_demo_workspaces_v1';
export const DEMO_STORAGE_KEY_RUNS = 'giga_demo_runs_v1';
export const MAX_USER_DEMO_WORKSPACES = 20;
export const MAX_USER_DEMO_RUNS = 50;

export const INITIAL_WORKSPACE_IDS = new Set(INITIAL_WORKSPACES.map((w) => w.id));
export const INITIAL_RUN_IDS = new Set(INITIAL_RUNS.map((r) => r.id));

function getDemoStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
    if (typeof globalThis !== 'undefined' && (globalThis as any).localStorage) {
      return (globalThis as any).localStorage;
    }
  } catch {
    return null;
  }
  return null;
}

export const CANONICAL_AGENT_STATUSES = new Set<AgentStatus>([
  'queued',
  'running',
  'awaiting_approval',
  'applying',
  'completed',
  'failed',
  'cancelled',
]);

export const CANONICAL_AGENT_PHASES = new Set([
  'waiting_runtime',
  'planning',
  'executing',
  'observing',
  'verifying',
]);

export const CANONICAL_AGENT_MODES = new Set<AgentMode>([
  'ask',
  'plan',
  'execute',
]);

const VALID_PLAN_STEP_STATUSES = new Set(['completed', 'running', 'pending', 'failed']);
const VALID_TIMELINE_STATUSES = new Set(['completed', 'running', 'pending', 'failed']);
const VALID_FILE_CHANGE_STATUSES = new Set(['created', 'modified', 'deleted']);
const VALID_CHECK_OUTCOMES = new Set(['passed', 'failed', 'not_run']);
const VALID_APPROVAL_RISKS = new Set(['low', 'medium', 'high']);
const VALID_APPROVAL_STATUSES = new Set(['pending', 'approved', 'rejected']);

export function isValidWorkspace(item: unknown): item is AgentWorkspace {
  if (!item || typeof item !== 'object') return false;
  const w = item as Record<string, unknown>;
  return (
    typeof w.id === 'string' &&
    w.id.length > 0 &&
    typeof w.name === 'string' &&
    w.name.length > 0 &&
    w.sourceKind === 'blank' &&
    typeof w.revision === 'number' &&
    typeof w.createdAt === 'string' &&
    typeof w.updatedAt === 'string'
  );
}

export function isValidPlanStep(item: unknown): item is PlanStep {
  if (!item || typeof item !== 'object') return false;
  const s = item as Record<string, unknown>;
  return (
    typeof s.id === 'string' &&
    s.id.length > 0 &&
    typeof s.stepNumber === 'number' &&
    typeof s.title === 'string' &&
    typeof s.description === 'string' &&
    typeof s.status === 'string' &&
    VALID_PLAN_STEP_STATUSES.has(s.status)
  );
}

export function isValidTimelineEvent(item: unknown): item is TimelineEvent {
  if (!item || typeof item !== 'object') return false;
  const e = item as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    e.id.length > 0 &&
    typeof e.timestamp === 'string' &&
    typeof e.category === 'string' &&
    typeof e.label === 'string' &&
    (e.detail === undefined || typeof e.detail === 'string') &&
    typeof e.status === 'string' &&
    VALID_TIMELINE_STATUSES.has(e.status) &&
    (e.durationMs === undefined || typeof e.durationMs === 'number')
  );
}

export function isValidWorkspaceFileChange(item: unknown): item is WorkspaceFileChange {
  if (!item || typeof item !== 'object') return false;
  const f = item as Record<string, unknown>;
  return (
    typeof f.path === 'string' &&
    f.path.length > 0 &&
    typeof f.status === 'string' &&
    VALID_FILE_CHANGE_STATUSES.has(f.status) &&
    (f.additions === undefined || typeof f.additions === 'number') &&
    (f.deletions === undefined || typeof f.deletions === 'number') &&
    (f.diffPreview === undefined || typeof f.diffPreview === 'string')
  );
}

export function isValidVerifiedCheck(item: unknown): item is VerifiedCheck {
  if (!item || typeof item !== 'object') return false;
  const c = item as Record<string, unknown>;
  return (
    typeof c.name === 'string' &&
    c.name.length > 0 &&
    typeof c.outcome === 'string' &&
    VALID_CHECK_OUTCOMES.has(c.outcome) &&
    (c.summary === undefined || typeof c.summary === 'string')
  );
}

export function isValidArtifactItem(item: unknown): item is AgentArtifactItem {
  if (!item || typeof item !== 'object') return false;
  const a = item as Record<string, unknown>;
  return (
    typeof a.id === 'string' &&
    a.id.length > 0 &&
    typeof a.name === 'string' &&
    typeof a.type === 'string' &&
    typeof a.size === 'string' &&
    typeof a.summary === 'string' &&
    (a.isDemo === undefined || typeof a.isDemo === 'boolean')
  );
}

export function isValidApprovalRequest(item: unknown): item is ExternalApprovalRequest {
  if (!item || typeof item !== 'object') return false;
  const app = item as Record<string, unknown>;
  return (
    typeof app.id === 'string' &&
    app.id.length > 0 &&
    typeof app.action === 'string' &&
    typeof app.target === 'string' &&
    typeof app.risk === 'string' &&
    VALID_APPROVAL_RISKS.has(app.risk) &&
    typeof app.reason === 'string' &&
    typeof app.scope === 'string' &&
    typeof app.sideEffects === 'string' &&
    typeof app.status === 'string' &&
    VALID_APPROVAL_STATUSES.has(app.status)
  );
}

export function isValidRunResult(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const res = item as Record<string, unknown>;
  return (
    typeof res.summary === 'string' &&
    Array.isArray(res.artifactIds) &&
    res.artifactIds.every((id) => typeof id === 'string') &&
    Array.isArray(res.verifiedChecks) &&
    res.verifiedChecks.every(isValidVerifiedCheck)
  );
}

export function isValidRunError(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const err = item as Record<string, unknown>;
  return typeof err.code === 'string' && typeof err.message === 'string';
}

export function isValidRunDetail(item: unknown): item is AgentRunDetail {
  if (!item || typeof item !== 'object') return false;
  const r = item as Record<string, unknown>;

  // Required scalar identity & contract fields
  if (
    typeof r.id !== 'string' ||
    r.id.length === 0 ||
    typeof r.workspaceId !== 'string' ||
    r.workspaceId.length === 0 ||
    typeof r.workspaceName !== 'string' ||
    typeof r.task !== 'string' ||
    typeof r.mode !== 'string' ||
    !CANONICAL_AGENT_MODES.has(r.mode as AgentMode) ||
    typeof r.status !== 'string' ||
    !CANONICAL_AGENT_STATUSES.has(r.status as AgentStatus) ||
    typeof r.createdAt !== 'string'
  ) {
    return false;
  }

  // Optional scalar fields
  if (r.runtime !== undefined && typeof r.runtime !== 'string') return false;
  if (r.modelId !== undefined && typeof r.modelId !== 'string') return false;
  if (r.updatedAt !== undefined && typeof r.updatedAt !== 'string') return false;
  if (r.finishedAt !== undefined && typeof r.finishedAt !== 'string') return false;

  // Canonical optional phase (treated strictly as optional phase, never public status)
  if (r.phase !== undefined && (typeof r.phase !== 'string' || !CANONICAL_AGENT_PHASES.has(r.phase))) {
    return false;
  }

  // Optional error object
  if (r.error !== undefined && !isValidRunError(r.error)) {
    return false;
  }

  // Optional result object
  if (r.result !== undefined && !isValidRunResult(r.result)) {
    return false;
  }

  // Nested presentation structures: plan, timeline, fileChanges, verifications, artifacts
  if (!Array.isArray(r.plan) || !r.plan.every(isValidPlanStep)) {
    return false;
  }

  if (!Array.isArray(r.timeline) || !r.timeline.every(isValidTimelineEvent)) {
    return false;
  }

  if (!Array.isArray(r.fileChanges) || !r.fileChanges.every(isValidWorkspaceFileChange)) {
    return false;
  }

  if (!Array.isArray(r.verifications) || !r.verifications.every(isValidVerifiedCheck)) {
    return false;
  }

  if (!Array.isArray(r.artifacts) || !r.artifacts.every(isValidArtifactItem)) {
    return false;
  }

  // Optional approval request
  if (r.approvalRequest !== undefined && !isValidApprovalRequest(r.approvalRequest)) {
    return false;
  }

  return true;
}

// Mutable Demo State Manager for Browser Session with Bounded Local Persistence
export class WorkspaceFixtureStore {
  private workspaces: AgentWorkspace[] = [...INITIAL_WORKSPACES];
  private runs: AgentRunDetail[] = [...INITIAL_RUNS];

  constructor() {
    this.rehydrateFromStorage();
  }

  private loadPersistedWorkspaces(): AgentWorkspace[] {
    const storage = getDemoStorage();
    if (!storage) return [];
    try {
      const raw = storage.getItem(DEMO_STORAGE_KEY_WORKSPACES);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(isValidWorkspace)
        .filter((w) => !INITIAL_WORKSPACE_IDS.has(w.id))
        .slice(0, MAX_USER_DEMO_WORKSPACES);
    } catch {
      return [];
    }
  }

  private loadPersistedRuns(): AgentRunDetail[] {
    const storage = getDemoStorage();
    if (!storage) return [];
    try {
      const raw = storage.getItem(DEMO_STORAGE_KEY_RUNS);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(isValidRunDetail)
        .filter((r) => !INITIAL_RUN_IDS.has(r.id))
        .slice(0, MAX_USER_DEMO_RUNS)
        .map((r) => ({
          ...r,
          isDemo: true as const,
        }));
    } catch {
      return [];
    }
  }

  private persistWorkspaces(): void {
    const storage = getDemoStorage();
    if (!storage) return;
    try {
      const userWorkspaces = this.workspaces
        .filter((w) => !INITIAL_WORKSPACE_IDS.has(w.id))
        .slice(0, MAX_USER_DEMO_WORKSPACES);
      storage.setItem(DEMO_STORAGE_KEY_WORKSPACES, JSON.stringify(userWorkspaces));
    } catch {
      // safe fallback
    }
  }

  private persistRuns(): void {
    const storage = getDemoStorage();
    if (!storage) return;
    try {
      const userRuns = this.runs
        .filter((r) => !INITIAL_RUN_IDS.has(r.id))
        .slice(0, MAX_USER_DEMO_RUNS)
        .map((r) => ({
          ...r,
          isDemo: true as const,
        }));
      storage.setItem(DEMO_STORAGE_KEY_RUNS, JSON.stringify(userRuns));
    } catch {
      // safe fallback
    }
  }

  rehydrateFromStorage(): void {
    const userWorkspaces = this.loadPersistedWorkspaces();
    const userRuns = this.loadPersistedRuns();

    // Deterministic seeded fixtures are always preserved and deduplicated
    this.workspaces = [...userWorkspaces, ...INITIAL_WORKSPACES];
    this.runs = [...userRuns, ...INITIAL_RUNS];
  }

  reset(): void {
    const storage = getDemoStorage();
    if (storage) {
      try {
        storage.removeItem(DEMO_STORAGE_KEY_WORKSPACES);
        storage.removeItem(DEMO_STORAGE_KEY_RUNS);
      } catch {
        // ignore
      }
    }
    this.workspaces = [...INITIAL_WORKSPACES];
    this.runs = [...INITIAL_RUNS];
  }

  getWorkspaces(): AgentWorkspace[] {
    return [...this.workspaces];
  }

  getWorkspace(id: string): AgentWorkspace | null {
    return this.workspaces.find((w) => w.id === id) || null;
  }

  createWorkspace(name?: string): AgentWorkspace {
    const wsName = name?.trim() || `Blank Workspace ${this.workspaces.length + 1}`;
    const newWs: AgentWorkspace = {
      id: `ws-${Date.now()}`,
      name: wsName,
      sourceKind: 'blank',
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.workspaces.unshift(newWs);
    this.persistWorkspaces();
    return newWs;
  }

  getRuns(workspaceId?: string): AgentRunDetail[] {
    if (workspaceId) {
      return this.runs.filter((r) => r.workspaceId === workspaceId);
    }
    return [...this.runs];
  }

  getRun(id: string): AgentRunDetail | null {
    return this.runs.find((r) => r.id === id) || null;
  }

  createDemoRun(params: {
    workspaceId: string;
    task: string;
    mode: AgentMode;
  }): AgentRunDetail {
    const ws = this.getWorkspace(params.workspaceId) || this.workspaces[0];
    const runId = `run-${Date.now()}`;
    const now = new Date().toISOString();

    const isExecute = params.mode === 'execute';
    const isPlan = params.mode === 'plan';

    const newRun: AgentRunDetail = {
      id: runId,
      workspaceId: ws.id,
      workspaceName: ws.name,
      task: params.task,
      mode: params.mode,
      runtime: 'cloud',
      modelId: 'giga-agent-default',
      status: 'completed',
      phase: isExecute ? 'verifying' : 'executing',
      createdAt: now,
      updatedAt: now,
      finishedAt: now,
      isDemo: true,
      result: {
        summary: isExecute
          ? `Successfully executed task in isolated sandbox for "${params.task.slice(0, 40)}..."`
          : isPlan
          ? `Structured plan generated for "${params.task.slice(0, 40)}..."`
          : `Analysis and explanation provided for "${params.task.slice(0, 40)}..."`,
        artifactIds: isExecute ? [`art-${runId}-src`] : [],
        verifiedChecks: isExecute
          ? [
              { name: 'TypeScript Typecheck', outcome: 'passed', summary: 'tsc --noEmit: 0 errors' },
              { name: 'Production Build', outcome: 'passed', summary: 'vite build: completed successfully' },
            ]
          : [],
      },
      plan: [
        {
          id: `${runId}-step-1`,
          stepNumber: 1,
          title: 'Understand requirements',
          description: `Analyze instruction: "${params.task.slice(0, 60)}..."`,
          status: 'completed',
        },
        {
          id: `${runId}-step-2`,
          stepNumber: 2,
          title: isExecute ? 'Inspect workspace & create files' : 'Formulate analysis',
          description: isExecute ? 'Perform permitted sandbox edits' : 'Structure technical response',
          status: 'completed',
        },
        ...(isExecute
          ? [
              {
                id: `${runId}-step-3`,
                stepNumber: 3,
                title: 'Run verification',
                description: 'Verify types, tests and production bundle',
                status: 'completed' as const,
              },
            ]
          : []),
      ],
      timeline: [
        {
          id: `${runId}-evt-1`,
          timestamp: new Date().toLocaleTimeString(),
          category: 'Plan created',
          label: 'Generated task execution plan',
          status: 'completed',
        },
        {
          id: `${runId}-evt-2`,
          timestamp: new Date().toLocaleTimeString(),
          category: isExecute ? 'Write file' : 'Inspect workspace',
          label: isExecute ? 'Modified sandbox source files' : 'Inspected context',
          status: 'completed',
        },
        ...(isExecute
          ? [
              {
                id: `${runId}-evt-3`,
                timestamp: new Date().toLocaleTimeString(),
                category: 'Verify result',
                label: 'Passed sandbox build verification',
                status: 'completed' as const,
              },
            ]
          : []),
      ],
      fileChanges: isExecute
        ? [
            {
              path: 'src/solution.tsx',
              status: 'created',
              additions: 42,
              deletions: 0,
              diffPreview: `@@ -0,0 +1,42 @@\n+// Implemented solution for: ${params.task}`,
            },
          ]
        : [],
      verifications: isExecute
        ? [
            { name: 'TypeScript Check', outcome: 'passed', summary: '0 diagnostics.' },
            { name: 'Build Verification', outcome: 'passed', summary: 'Vite build passed.' },
          ]
        : [],
      artifacts: isExecute
        ? [
            {
              id: `art-${runId}-src`,
              name: 'workspace-solution.zip',
              type: 'Source Project (ZIP)',
              size: '18.4 KB',
              isDemo: true,
              summary: 'Sandbox output source files for completed task.',
            },
          ]
        : [],
    };

    this.runs.unshift(newRun);
    this.persistRuns();
    return newRun;
  }

  cancelDemoRun(id: string): AgentRunDetail | null {
    const run = this.getRun(id);
    if (!run) return null;
    const updated: AgentRunDetail = {
      ...run,
      status: 'cancelled',
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      error: { code: 'CANCELLED', message: 'Run was cancelled by user request.' },
    };
    const idx = this.runs.findIndex((r) => r.id === id);
    if (idx !== -1) {
      this.runs[idx] = updated;
    }
    this.persistRuns();
    return updated;
  }

  decideApproval(id: string, decision: 'approve' | 'reject'): AgentRunDetail | null {
    const run = this.getRun(id);
    if (!run || !run.approvalRequest) return null;

    if (decision === 'reject') {
      const updated: AgentRunDetail = {
        ...run,
        status: 'cancelled',
        updatedAt: new Date().toISOString(),
        approvalRequest: { ...run.approvalRequest, status: 'rejected' },
        error: { code: 'APPROVAL_REJECTED', message: 'External action was rejected by reviewer.' },
      };
      const idx = this.runs.findIndex((r) => r.id === id);
      if (idx !== -1) this.runs[idx] = updated;
      this.persistRuns();
      return updated;
    }

    // Approve
    const updated: AgentRunDetail = {
      ...run,
      status: 'completed',
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      approvalRequest: { ...run.approvalRequest, status: 'approved' },
      result: {
        summary: 'External action approved and executed successfully.',
        artifactIds: [],
        verifiedChecks: run.verifications,
      },
    };
    const idx = this.runs.findIndex((r) => r.id === id);
    if (idx !== -1) this.runs[idx] = updated;
    this.persistRuns();
    return updated;
  }

  resetToDefaults() {
    this.reset();
  }

  createRun(params: {
    workspaceId: string;
    task: string;
    mode: AgentMode;
  }): AgentRunDetail {
    return this.createDemoRun(params);
  }

  updateRunStatus(id: string, status: AgentStatus): AgentRunDetail | null {
    const run = this.getRun(id);
    if (!run) return null;
    const updated: AgentRunDetail = {
      ...run,
      status,
      updatedAt: new Date().toISOString(),
      ...(status === 'completed' || status === 'failed' || status === 'cancelled'
        ? { finishedAt: new Date().toISOString() }
        : {}),
      ...(status === 'awaiting_approval' && !run.approvalRequest
        ? {
            approvalRequest: {
              id: `req-${Date.now()}`,
              action: 'deploy_staging',
              target: 'https://staging.giga.internal/deployments',
              risk: 'high',
              reason: 'Deploy sandbox build to staging environment',
              scope: 'Network deployment to external staging host',
              sideEffects: 'Changes remote cluster state',
              status: 'pending',
            },
          }
        : {}),
    };
    const idx = this.runs.findIndex((r) => r.id === id);
    if (idx !== -1) this.runs[idx] = updated;
    this.persistRuns();
    return updated;
  }
}

export const workspaceFixtureStore = new WorkspaceFixtureStore();

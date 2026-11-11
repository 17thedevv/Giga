import type { WorkspaceFileChange } from './workspace-fixtures.js';

export interface DemoAgentDiffFixtureSet {
  readonly provenance: 'demo-fixture';
  readonly files: readonly unknown[];
}

const GOLDEN_REACT_DIFFS: DemoAgentDiffFixtureSet = {
  provenance: 'demo-fixture',
  files: [
    {
      path: 'src/App.tsx',
      status: 'created',
      beforeRevision: 'No before file (Demo)',
      afterRevision: 'Demo revision 1',
      preview: {
        kind: 'partial',
        hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 4, lines: [
          { kind: 'addition', text: 'import React from "react";' },
          { kind: 'addition', text: 'import { TaskList } from "./components/TaskList";' },
          { kind: 'addition', text: '' },
          { kind: 'addition', text: 'export function App() { return <TaskList />; }' },
        ] }],
      },
    },
    {
      path: 'src/components/TaskList.tsx',
      status: 'created',
      beforeRevision: 'No before file (Demo)',
      afterRevision: 'Demo revision 1',
      preview: {
        kind: 'partial',
        hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2, lines: [
          { kind: 'addition', text: 'export function TaskList() {' },
          { kind: 'addition', text: '  return <ul aria-label="Tasks" />;' },
        ] }],
      },
    },
    {
      path: 'src/styles.css',
      status: 'created',
      beforeRevision: 'No before file (Demo)',
      afterRevision: 'Demo revision 1',
      preview: {
        kind: 'partial',
        hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2, lines: [
          { kind: 'addition', text: ':root { color-scheme: dark; }' },
          { kind: 'addition', text: '.task-card { border-radius: 8px; }' },
        ] }],
      },
    },
    {
      path: 'package.json',
      status: 'modified',
      beforeRevision: 'Demo revision 1',
      afterRevision: 'Demo revision 2',
      preview: {
        kind: 'partial',
        hunks: [{ oldStart: 12, oldCount: 3, newStart: 12, newCount: 3, lines: [
          { kind: 'context', text: '  "scripts": {' },
          { kind: 'deletion', text: '    "test": "echo not configured"' },
          { kind: 'addition', text: '    "test": "vitest run"' },
          { kind: 'context', text: '  }' },
        ] }],
      },
    },
    {
      path: 'src/components/index.ts',
      status: 'created',
      beforeRevision: 'No before file (Demo)',
      afterRevision: 'Demo revision 1',
      preview: {
        kind: 'complete',
        hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 3, lines: [
          { kind: 'addition', text: 'export { TaskList } from "./TaskList";' },
          { kind: 'addition', text: 'export type { TaskItem } from "./types";' },
          { kind: 'addition', text: '' },
        ] }],
      },
    },
    {
      path: 'src/utils/index.ts',
      status: 'modified',
      beforeRevision: 'Demo revision 1',
      afterRevision: 'Demo revision 2',
      preview: {
        kind: 'complete',
        hunks: [
          { oldStart: 1, oldCount: 2, newStart: 1, newCount: 3, lines: [
            { kind: 'context', text: 'export const mode = "legacy";' },
            { kind: 'deletion', text: 'export const retries = 2;' },
            { kind: 'addition', text: 'export const retries = 3;' },
            { kind: 'addition', text: 'export const timeoutMs = 5000;' },
          ] },
          { oldStart: 10, oldCount: 1, newStart: 11, newCount: 1, lines: [
            { kind: 'context', text: '}' },
            { kind: 'no-newline', appliesTo: 'both' },
          ] },
        ],
      },
    },
    {
      path: 'docs/Release notes à lire.md',
      status: 'created',
      beforeRevision: 'No before file (Demo)',
      afterRevision: 'Demo revision 1',
      preview: {
        kind: 'complete',
        hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2, lines: [
          { kind: 'addition', text: '# Révision de démonstration' },
          { kind: 'addition', text: 'Bonjour, Giga Agent 👋' },
        ] }],
      },
    },
    {
      path: 'docs/old setup guide.md',
      status: 'deleted',
      beforeRevision: 'Demo revision 1',
      afterRevision: 'No after file (Demo)',
      preview: {
        kind: 'complete',
        hunks: [{ oldStart: 1, oldCount: 3, newStart: 0, newCount: 0, lines: [
          { kind: 'deletion', text: '# Old setup' },
          { kind: 'deletion', text: 'This guide is no longer current.' },
          { kind: 'deletion', text: 'Use the workspace guide instead.' },
        ] }],
      },
    },
    {
      path: 'assets/logo.png',
      status: 'modified',
      beforeRevision: 'Demo revision 1',
      afterRevision: 'Demo revision 2',
      preview: { kind: 'binary', message: 'This Demo file is binary; text diff content is unavailable.' },
    },
    {
      path: 'src/large-preview.ts',
      status: 'modified',
      beforeRevision: 'Demo revision 1',
      afterRevision: 'Demo revision 2',
      preview: { kind: 'too-large', message: 'This Demo diff is intentionally over the preview budget.' },
    },
  ],
};

const FIXTURES = new Map<string, DemoAgentDiffFixtureSet>([
  ['run-golden-react', GOLDEN_REACT_DIFFS],
]);

/** Retrieves deterministic frontend-only examples. This is never called from Real Mode. */
export function getDemoAgentDiffFixtures(runId: string): DemoAgentDiffFixtureSet | undefined {
  return FIXTURES.get(runId);
}

/** Keep the fixture summary type linked to the existing Demo run shape without using its abbreviated diffPreview. */
export type DemoChangeSummary = Pick<WorkspaceFileChange, 'path' | 'status' | 'additions' | 'deletions'>;

import type { AgentSnapshotEntry, DemoWorkspaceSnapshot } from './agent-file-model.js';

function textFile(path: string, content: string): AgentSnapshotEntry {
  return { path, kind: 'file', sizeBytes: new TextEncoder().encode(content).byteLength, preview: { kind: 'text', content } };
}

function filePlaceholder(path: string, sizeBytes: number | null, kind: 'binary' | 'too-large' | 'unsupported' | 'unavailable' | 'error'): AgentSnapshotEntry {
  return { path, kind: 'file', sizeBytes, preview: { kind } };
}

const reactSnapshot: DemoWorkspaceSnapshot = {
  workspaceId: 'ws-react-task-manager',
  snapshotId: 'demo-react-task-manager-r1',
  provenance: 'demo-fixture',
  partial: false,
  entries: [
    { path: 'src', kind: 'folder' },
    { path: 'src/components', kind: 'folder' },
    { path: 'src/pages', kind: 'folder' },
    { path: 'src/lib', kind: 'folder' },
    { path: 'src/styles', kind: 'folder' },
    { path: 'public', kind: 'folder' },
    { path: 'notes', kind: 'folder' },
    { path: 'config', kind: 'folder' },
    textFile('src/App.tsx', "import { TaskList } from './components/TaskList';\n\nexport function App() {\n  return <TaskList />;\n}\n"),
    textFile('src/components/TaskList.tsx', "type Task = { id: string; title: string; done: boolean };\n\nexport function TaskList() {\n  const tasks: Task[] = [];\n  return <ul>{tasks.map((task) => <li key={task.id}>{task.title}</li>)}</ul>;\n}\n"),
    textFile('src/pages/Home.tsx', "export const pageTitle = 'Tasks';\n"),
    textFile('src/lib/format.ts', "export const formatCount = (count: number) => `${count} tasks`;\n"),
    textFile('src/lib/client.js', "export const apiOrigin = 'https://example.invalid';\n"),
    textFile('src/styles/app.css', '.task-list {\n  display: grid;\n  gap: 0.75rem;\n}\n'),
    textFile('public/index.html', '<!doctype html>\n<html><head><title>Demo source</title></head><body><div id="root"></div></body></html>\n'),
    textFile('package.json', '{\n  "name": "demo-task-manager",\n  "private": true,\n  "scripts": { "build": "vite build" }\n}\n'),
    textFile('tsconfig.json', '{\n  "compilerOptions": { "strict": true, "jsx": "react-jsx" }\n}\n'),
    textFile('README.md', '# Demo Task Manager\n\nA deterministic source preview fixture. It is not a generated or persisted Cloud workspace.\n'),
    textFile('notes/summary.txt', 'Demo only.\n\nWhitespace and line breaks are preserved.\n'),
    textFile('config/settings.yaml', 'preview: read-only\nsource: demo-fixture\n'),
    textFile('config/.env.example', 'API_ORIGIN=https://example.invalid\n'),
  ],
};

const documentationSnapshot: DemoWorkspaceSnapshot = {
  workspaceId: 'ws-doc-site',
  snapshotId: 'demo-doc-site-r1',
  provenance: 'demo-fixture',
  partial: false,
  entries: [
    { path: 'src', kind: 'folder' },
    { path: 'src/components', kind: 'folder' },
    { path: 'src/pages', kind: 'folder' },
    { path: 'src/pages/guides/reference/api/v2/examples', kind: 'folder' },
    { path: 'public', kind: 'folder' },
    { path: 'empty-folder', kind: 'folder' },
    textFile('src/components/Button.tsx', "export const Button = () => <button type=\"button\">Open</button>;\n"),
    textFile('src/pages/Button.tsx', "export const ButtonPage = () => <main>Button guide</main>;\n"),
    textFile('src/pages/你好.tsx', "export const greeting = '你好，世界';\n"),
    textFile('src/components/ Large Tile.tsx', "export const title = 'Whitespace stays part of this filename';\n"),
    textFile('src/pages/guides/reference/api/v2/examples/readme.md', '# Deep Example\n\nA nested deterministic fixture.\n'),
    textFile(`notes/${'very-long-name-'.repeat(9)}tail.txt`, 'Long filenames remain selectable by their full relative path.\n'),
    textFile('README.md', '# Demo Documentation\n'),
  ],
};

const partialSnapshot: DemoWorkspaceSnapshot = {
  workspaceId: 'ws-csv-analytics',
  snapshotId: 'demo-csv-analytics-partial-r2',
  provenance: 'demo-fixture',
  partial: true,
  entries: [
    { path: 'data', kind: 'folder' },
    { path: 'src', kind: 'folder' },
    textFile('src/settings.yaml', 'title: Demo Analytics\nmode: sample\n'),
    textFile('src/empty.txt', ''),
    filePlaceholder('data/large-export.csv', 25_000_000, 'too-large'),
    filePlaceholder('public/logo.png', 4096, 'binary'),
    filePlaceholder('data/unsupported.csv', 128, 'unsupported'),
    filePlaceholder('src/pending.md', null, 'unavailable'),
    filePlaceholder('src/preview-error.json', 32, 'error'),
  ],
};

export const DEMO_WORKSPACE_SNAPSHOT_FIXTURES: Readonly<Record<string, DemoWorkspaceSnapshot>> = {
  [reactSnapshot.workspaceId]: reactSnapshot,
  [documentationSnapshot.workspaceId]: documentationSnapshot,
  [partialSnapshot.workspaceId]: partialSnapshot,
};

/** Returns labeled sample content only; unknown Demo workspaces get an empty sample. */
export function getDemoWorkspaceSnapshot(workspaceId: string): DemoWorkspaceSnapshot {
  const known = Object.prototype.hasOwnProperty.call(DEMO_WORKSPACE_SNAPSHOT_FIXTURES, workspaceId)
    ? DEMO_WORKSPACE_SNAPSHOT_FIXTURES[workspaceId]
    : undefined;
  if (known) return known;
  const safeId = /^[A-Za-z0-9._:-]{1,128}$/.test(workspaceId) ? workspaceId : 'demo-empty-workspace';
  return {
    workspaceId: safeId,
    snapshotId: 'demo-empty-sample-r1',
    provenance: 'demo-fixture',
    partial: false,
    entries: [],
  };
}

import { sanitizeUntrustedText } from '../../lib/security/untrusted-content.js';

export const MAX_AGENT_FILE_PATH_LENGTH = 1024;
export const MAX_AGENT_FILE_PATH_DEPTH = 32;
export const MAX_AGENT_FILE_SEGMENT_LENGTH = 255;
export const MAX_AGENT_SNAPSHOT_ENTRIES = 2000;
export const MAX_AGENT_PREVIEW_BYTES = 64 * 1024;
/** Caps both rendered line-number elements and source lines retained in a preview. */
export const MAX_AGENT_PREVIEW_LINES = 2000;
export const MAX_AGENT_SNAPSHOT_PREVIEW_BYTES = 512 * 1024;
const MAX_AGENT_FILE_SIZE_BYTES = 100_000_000_000;

export type AgentFilePreview =
  | { readonly kind: 'text'; readonly content: string }
  | { readonly kind: 'binary' | 'too-large' | 'too-many-lines' | 'unsupported' | 'unavailable' | 'error' };

export interface AgentSnapshotFile {
  readonly path: string;
  readonly kind: 'file';
  readonly sizeBytes: number | null;
  readonly preview: AgentFilePreview;
}

export interface AgentSnapshotFolder {
  readonly path: string;
  readonly kind: 'folder';
}

export type AgentSnapshotEntry = AgentSnapshotFile | AgentSnapshotFolder;

/** Frontend-only, immutable sample data. This is not a backend DTO or persisted snapshot. */
export interface DemoWorkspaceSnapshot {
  readonly workspaceId: string;
  readonly snapshotId: string;
  readonly provenance: 'demo-fixture';
  readonly partial: boolean;
  readonly entries: readonly AgentSnapshotEntry[];
}

export interface AgentFileTreeFolder {
  readonly path: string;
  readonly name: string;
  readonly kind: 'folder';
  readonly children: readonly AgentFileTreeNode[];
}

export interface AgentFileTreeFile extends AgentSnapshotFile {
  readonly name: string;
}

export type AgentFileTreeNode = AgentFileTreeFolder | AgentFileTreeFile;

export type SnapshotProjection =
  | { readonly ok: true; readonly snapshot: DemoWorkspaceSnapshot }
  | { readonly ok: false; readonly reason: 'invalid_snapshot' };

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const SAFE_FIXTURE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function validateWorkspaceRelativePath(path: unknown): { readonly ok: true; readonly segments: readonly string[] } | { readonly ok: false } {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_AGENT_FILE_PATH_LENGTH ||
      path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path) || path.includes('\\') ||
      CONTROL_CHARACTERS.test(path)) {
    return { ok: false };
  }
  const segments = path.split('/');
  if (segments.length > MAX_AGENT_FILE_PATH_DEPTH || segments.some((segment) =>
    segment.length === 0 || segment === '.' || segment === '..' || segment.length > MAX_AGENT_FILE_SEGMENT_LENGTH || segment.includes(':')
  )) {
    return { ok: false };
  }
  return { ok: true, segments };
}

const LANGUAGES: Readonly<Record<string, string>> = {
  ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', jsx: 'JSX', json: 'JSON', jsonc: 'JSON with comments',
  md: 'Markdown source', markdown: 'Markdown source', css: 'CSS', html: 'HTML source', htm: 'HTML source',
  txt: 'Plain text', text: 'Plain text', yaml: 'YAML', yml: 'YAML', toml: 'TOML', ini: 'INI', xml: 'XML source',
};

export function languageForAgentFile(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name.toLowerCase() === '.env.example') return 'Environment example';
  if (name.toLowerCase() === 'dockerfile') return 'Dockerfile source';
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return null;
  return LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * Counts logical source lines, treating CRLF as one delimiter. Stops at the
 * first line beyond `maximum`, so untrusted newline-dense content is scanned
 * only until it is known to exceed the rendering budget.
 */
export function countAgentPreviewLines(content: string, maximum = MAX_AGENT_PREVIEW_LINES): number {
  let lines = 1;
  for (let index = 0; index < content.length; index++) {
    const code = content.charCodeAt(index);
    if (code === 13) {
      lines++;
      if (content.charCodeAt(index + 1) === 10) index++;
    } else if (code === 10) {
      lines++;
    }
    if (lines > maximum) return maximum + 1;
  }
  return lines;
}

function safeSize(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_AGENT_FILE_SIZE_BYTES
    ? value
    : Number.NaN;
}

function previewWithoutContent(value: Record<string, unknown>): AgentFilePreview | null {
  if ('content' in value) return null;
  switch (value.kind) {
    case 'binary':
    case 'too-large':
    case 'too-many-lines':
    case 'unsupported':
    case 'unavailable':
    case 'error':
      return { kind: value.kind };
    default:
      return null;
  }
}

/**
 * Validates and projects the local Demo fixture shape. It rejects ambiguous paths
 * and collisions as a whole, and copies only the fields the UI needs.
 */
export function projectDemoWorkspaceSnapshot(value: unknown): SnapshotProjection {
  if (!isRecord(value) || value.provenance !== 'demo-fixture' || value.partial !== undefined && typeof value.partial !== 'boolean' ||
      typeof value.workspaceId !== 'string' || !SAFE_FIXTURE_ID.test(value.workspaceId) ||
      typeof value.snapshotId !== 'string' || !SAFE_FIXTURE_ID.test(value.snapshotId) ||
      !Array.isArray(value.entries) || value.entries.length > MAX_AGENT_SNAPSHOT_ENTRIES) {
    return { ok: false, reason: 'invalid_snapshot' };
  }

  const projected: AgentSnapshotEntry[] = [];
  const seenPaths = new Set<string>();
  const pathKinds = new Map<string, 'file' | 'folder'>();
  let retainedPreviewBytes = 0;

  for (const candidate of value.entries) {
    if (!isRecord(candidate)) return { ok: false, reason: 'invalid_snapshot' };
    const pathValidation = validateWorkspaceRelativePath(candidate.path);
    if (!pathValidation.ok || seenPaths.has(candidate.path as string) ||
        (candidate.kind !== 'file' && candidate.kind !== 'folder')) {
      return { ok: false, reason: 'invalid_snapshot' };
    }
    const path = candidate.path as string;
    seenPaths.add(path);

    const segments = pathValidation.segments;
    for (let index = 1; index < segments.length; index++) {
      const ancestor = segments.slice(0, index).join('/');
      if (pathKinds.get(ancestor) === 'file') return { ok: false, reason: 'invalid_snapshot' };
    }
    if (candidate.kind === 'file' && [...pathKinds.entries()].some(([otherPath, kind]) =>
      kind === 'folder' && otherPath.startsWith(path + '/')
    )) {
      return { ok: false, reason: 'invalid_snapshot' };
    }
    pathKinds.set(path, candidate.kind);

    if (candidate.kind === 'folder') {
      if ('preview' in candidate || 'sizeBytes' in candidate) return { ok: false, reason: 'invalid_snapshot' };
      projected.push({ path, kind: 'folder' });
      continue;
    }

    const declaredSize = safeSize(candidate.sizeBytes);
    if (typeof declaredSize === 'number' && Number.isNaN(declaredSize)) return { ok: false, reason: 'invalid_snapshot' };
    const rawPreview = candidate.preview;
    let preview: AgentFilePreview;
    let contentBytes: number | null = null;
    if (rawPreview === undefined) {
      preview = { kind: 'unavailable' };
    } else if (isRecord(rawPreview) && rawPreview.kind === 'text' && typeof rawPreview.content === 'string') {
      const rawContent = rawPreview.content;
      if (rawContent.length > MAX_AGENT_PREVIEW_BYTES) {
        preview = { kind: 'too-large' };
      } else {
        contentBytes = new TextEncoder().encode(rawContent).byteLength;
        if (contentBytes > MAX_AGENT_PREVIEW_BYTES) {
          preview = { kind: 'too-large' };
        } else if (declaredSize !== undefined && declaredSize !== null && declaredSize !== contentBytes) {
          return { ok: false, reason: 'invalid_snapshot' };
        } else if (languageForAgentFile(path) === null) {
          preview = { kind: 'unsupported' };
        } else if (countAgentPreviewLines(rawContent) > MAX_AGENT_PREVIEW_LINES) {
          preview = { kind: 'too-many-lines' };
        } else if (retainedPreviewBytes + contentBytes > MAX_AGENT_SNAPSHOT_PREVIEW_BYTES) {
          preview = { kind: 'too-large' };
        } else {
          retainedPreviewBytes += contentBytes;
          preview = { kind: 'text', content: sanitizeUntrustedText(rawContent) };
        }
      }
    } else if (isRecord(rawPreview)) {
      const safePreview = previewWithoutContent(rawPreview);
      if (!safePreview) return { ok: false, reason: 'invalid_snapshot' };
      preview = safePreview;
    } else {
      return { ok: false, reason: 'invalid_snapshot' };
    }

    const sizeBytes = declaredSize === undefined
      ? contentBytes
      : declaredSize;
    projected.push({ path, kind: 'file', sizeBytes, preview });
  }

  // A file cannot also be a parent directory, regardless of input ordering.
  for (const [path, kind] of pathKinds) {
    if (kind === 'file' && [...pathKinds.keys()].some((other) => other.startsWith(path + '/'))) {
      return { ok: false, reason: 'invalid_snapshot' };
    }
  }

  return {
    ok: true,
    snapshot: {
      workspaceId: value.workspaceId,
      snapshotId: value.snapshotId,
      provenance: 'demo-fixture',
      partial: value.partial === true,
      entries: projected,
    },
  };
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Builds a bounded folder tree from already projected entries. */
export function buildAgentFileTree(entries: readonly AgentSnapshotEntry[]): readonly AgentFileTreeNode[] {
  interface MutableFolder { path: string; name: string; kind: 'folder'; children: Map<string, MutableFolder | AgentFileTreeFile> }
  const root: MutableFolder = { path: '', name: '', kind: 'folder', children: new Map() };

  for (const entry of entries) {
    const path = validateWorkspaceRelativePath(entry.path);
    if (!path.ok) continue;
    let parent = root;
    for (let index = 0; index < path.segments.length; index++) {
      const name = path.segments[index]!;
      const nodePath = path.segments.slice(0, index + 1).join('/');
      const isLeaf = index === path.segments.length - 1;
      const existing = parent.children.get(name);
      if (isLeaf) {
        if (entry.kind === 'folder') {
          if (!existing) parent.children.set(name, { path: nodePath, name, kind: 'folder', children: new Map() });
          else if (existing.kind !== 'folder') continue;
        } else if (!existing) {
          parent.children.set(name, { ...entry, name });
        }
        continue;
      }
      if (existing?.kind === 'file') break;
      if (existing?.kind === 'folder') parent = existing;
      else {
        const folder: MutableFolder = { path: nodePath, name, kind: 'folder', children: new Map() };
        parent.children.set(name, folder);
        parent = folder;
      }
    }
  }

  const sortChildren = (folder: MutableFolder): readonly AgentFileTreeNode[] =>
    [...folder.children.values()]
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
        return compareNames(left.name, right.name);
      })
      .map((node) => node.kind === 'folder'
        ? { path: node.path, name: node.name, kind: 'folder', children: sortChildren(node) }
        : node);

  return sortChildren(root);
}

export function safeAgentFileDisplayText(value: string): string {
  return sanitizeUntrustedText(value);
}

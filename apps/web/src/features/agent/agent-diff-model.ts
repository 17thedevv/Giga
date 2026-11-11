import { sanitizeUntrustedText } from '../../lib/security/untrusted-content.js';
import { validateWorkspaceRelativePath } from './agent-file-model.js';

export const MAX_AGENT_CHANGE_FILES = 100;
export const MAX_AGENT_DIFF_BYTES_PER_FILE = 64 * 1024;
export const MAX_AGENT_DIFF_BYTES_TOTAL = 256 * 1024;
export const MAX_AGENT_DIFF_HUNKS = 80;
export const MAX_AGENT_DIFF_LINES = 2000;
export const MAX_AGENT_DIFF_LINE_LENGTH = 8192;
export const MAX_AGENT_DIFF_RENDER_ROWS = 2000;
export const MAX_AGENT_DIFF_EXPANDED_CONTEXT = 200;
export const MAX_AGENT_DIFF_COPY_BYTES = 32 * 1024;

export type AgentChangeStatus = 'created' | 'modified' | 'deleted';
export type AgentDiffLineKind = 'context' | 'addition' | 'deletion' | 'no-newline';
export type AgentDiffSide = 'before' | 'after' | 'both';

export interface AgentDiffLine {
  readonly key: string;
  readonly kind: AgentDiffLineKind;
  readonly text: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly appliesTo?: AgentDiffSide;
}

export interface AgentDiffHunk {
  readonly key: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly AgentDiffLine[];
}

export type AgentDiffPreview =
  | { readonly kind: 'complete' | 'partial'; readonly hunks: readonly AgentDiffHunk[] }
  | { readonly kind: 'unavailable' | 'binary' | 'too-large'; readonly message: string };

export interface AgentChangeFile {
  readonly key: string;
  readonly path: string;
  readonly status: AgentChangeStatus;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly provenance: 'Demo sample';
  readonly beforeRevision: string;
  readonly afterRevision: string;
  readonly preview: AgentDiffPreview;
}

export type AgentChangeProjection =
  | { readonly ok: true; readonly files: readonly AgentChangeFile[] }
  | { readonly ok: false; readonly reason: 'invalid-change-set' | 'too-many-files' };

interface SafeSummary {
  path: string;
  status: AgentChangeStatus;
  additions: number | null;
  deletions: number | null;
}

interface ParsedPreview {
  preview: AgentDiffPreview;
  additions: number | null;
  deletions: number | null;
  bytes: number;
  tooLarge: boolean;
}

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const ANSI_SEQUENCES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const ANY_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const SAFE_COUNT = 10_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function safeCount(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= SAFE_COUNT
    ? value
    : null;
}

function cleanLabel(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 80 || ANY_CONTROL_CHARACTERS.test(value)) return null;
  return sanitizeUntrustedText(value);
}

function projectSummaries(value: unknown): SafeSummary[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_AGENT_CHANGE_FILES) return null;
  const files: SafeSummary[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) return null;
    const pathResult = validateWorkspaceRelativePath(item.path);
    if (!pathResult.ok || sanitizeUntrustedText(item.path as string) !== item.path || seen.has(item.path as string) ||
        !['created', 'modified', 'deleted'].includes(String(item.status))) return null;
    const additions = safeCount(item.additions);
    const deletions = safeCount(item.deletions);
    if (additions === null || deletions === null) return null;
    const status = item.status as AgentChangeStatus;
    if ((status === 'created' && deletions !== undefined && deletions !== 0) ||
        (status === 'deleted' && additions !== undefined && additions !== 0)) return null;
    seen.add(item.path as string);
    files.push({
      path: item.path as string,
      status,
      additions: additions ?? null,
      deletions: deletions ?? null,
    });
  }

  const paths = new Set(files.map((file) => file.path));
  for (const path of paths) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      if (paths.has(parts.slice(0, index).join('/'))) return null;
    }
  }
  return files;
}

function cleanDiffLine(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_AGENT_DIFF_LINE_LENGTH || /[\r\n]/.test(value)) return null;
  const withoutTerminalControls = value.replace(ANSI_SEQUENCES, '').replace(CONTROL_CHARACTERS, '');
  return sanitizeUntrustedText(withoutTerminalControls);
}

function countLineBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function tooLargePreview(): ParsedPreview {
  return {
    preview: { kind: 'too-large', message: 'This sample diff exceeds the safe preview or rendering budget.' },
    additions: null,
    deletions: null,
    bytes: 0,
    tooLarge: true,
  };
}

function parsePreview(
  value: unknown,
  path: string,
  status: AgentChangeStatus,
  declaredAdditions: number | null,
  declaredDeletions: number | null,
): ParsedPreview | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'unavailable' || value.kind === 'binary' || value.kind === 'too-large') {
    if ('hunks' in value) return null;
    const fallback = value.kind === 'binary'
      ? 'Binary content is not available as text.'
      : value.kind === 'too-large'
        ? 'This diff exceeds the safe preview or rendering budget.'
        : 'A complete structured diff is not available for this sample.';
    const message = value.message === undefined ? fallback : cleanLabel(value.message);
    if (!message) return null;
    return {
      preview: { kind: value.kind, message },
      additions: null,
      deletions: null,
      bytes: 0,
      tooLarge: value.kind === 'too-large',
    };
  }

  if (value.kind !== 'complete' && value.kind !== 'partial') return null;
  if (!Array.isArray(value.hunks) || value.hunks.length === 0) return null;
  if (value.hunks.length > MAX_AGENT_DIFF_HUNKS) return tooLargePreview();
  let totalRows = 0;
  for (const candidate of value.hunks) {
    if (!isRecord(candidate) || !Array.isArray(candidate.lines)) return null;
    totalRows += candidate.lines.length;
    if (totalRows > MAX_AGENT_DIFF_LINES || totalRows + value.hunks.length > MAX_AGENT_DIFF_RENDER_ROWS) return tooLargePreview();
  }

  const hunks: AgentDiffHunk[] = [];
  let computedAdditions = 0;
  let computedDeletions = 0;
  let byteLength = 0;
  let priorOldEnd = -1;
  let priorNewEnd = -1;

  for (let hunkIndex = 0; hunkIndex < value.hunks.length; hunkIndex++) {
    const rawHunk = value.hunks[hunkIndex];
    if (!isRecord(rawHunk) || !Array.isArray(rawHunk.lines) || rawHunk.lines.length === 0) return null;
    const oldStart = safeCount(rawHunk.oldStart);
    const newStart = safeCount(rawHunk.newStart);
    const declaredOldCount = safeCount(rawHunk.oldCount);
    const declaredNewCount = safeCount(rawHunk.newCount);
    if (oldStart === undefined || oldStart === null || newStart === undefined || newStart === null ||
        declaredOldCount === undefined || declaredOldCount === null ||
        declaredNewCount === undefined || declaredNewCount === null ||
        (declaredOldCount > 0 && oldStart === 0) ||
        (declaredNewCount > 0 && newStart === 0) ||
        oldStart < priorOldEnd || newStart < priorNewEnd) return null;

    let oldLine = oldStart;
    let newLine = newStart;
    const lines: AgentDiffLine[] = [];
    let lastContentKind: AgentDiffLineKind | null = null;
    let sawMarker = false;
    for (let lineIndex = 0; lineIndex < rawHunk.lines.length; lineIndex++) {
      const rawLine = rawHunk.lines[lineIndex];
      if (!isRecord(rawLine) || typeof rawLine.kind !== 'string') return null;
      if (rawLine.kind === 'no-newline') {
        const appliesTo = rawLine.appliesTo;
        const validSide = appliesTo === 'before' || appliesTo === 'after' || appliesTo === 'both';
        const previousSupportsSide = appliesTo === 'before'
          ? lastContentKind === 'deletion' || lastContentKind === 'context'
          : appliesTo === 'after'
            ? lastContentKind === 'addition' || lastContentKind === 'context'
            : lastContentKind === 'context';
        const isFinalMarker = hunkIndex === value.hunks.length - 1 && lineIndex === rawHunk.lines.length - 1;
        if (!validSide || !previousSupportsSide || !isFinalMarker || sawMarker) return null;
        lines.push({
          key: `${path}\u0000${hunkIndex}\u0000${lineIndex}`,
          kind: 'no-newline',
          text: '\\ No newline at end of file',
          oldLine: null,
          newLine: null,
          appliesTo,
        });
        sawMarker = true;
        continue;
      }

      if (rawLine.kind !== 'context' && rawLine.kind !== 'addition' && rawLine.kind !== 'deletion') return null;
      if (typeof rawLine.text !== 'string') return null;
      if (rawLine.text.length > MAX_AGENT_DIFF_LINE_LENGTH) return tooLargePreview();
      const text = cleanDiffLine(rawLine.text);
      if (text === null) return null;
      byteLength += countLineBytes(text) + 2;
      if (byteLength > MAX_AGENT_DIFF_BYTES_PER_FILE) return tooLargePreview();
      let oldNumber: number | null = null;
      let newNumber: number | null = null;
      if (rawLine.kind === 'context' || rawLine.kind === 'deletion') oldNumber = oldLine++;
      if (rawLine.kind === 'context' || rawLine.kind === 'addition') newNumber = newLine++;
      if (rawLine.kind === 'addition') computedAdditions++;
      if (rawLine.kind === 'deletion') computedDeletions++;
      lines.push({
        key: `${path}\u0000${hunkIndex}\u0000${lineIndex}`,
        kind: rawLine.kind,
        text,
        oldLine: oldNumber,
        newLine: newNumber,
      });
      lastContentKind = rawLine.kind;
    }

    const oldCount = oldLine - oldStart;
    const newCount = newLine - newStart;
    if (oldCount !== declaredOldCount || newCount !== declaredNewCount) return null;
    priorOldEnd = oldStart + oldCount;
    priorNewEnd = newStart + newCount;
    hunks.push({
      key: `${path}\u0000${hunkIndex}`,
      oldStart,
      oldCount,
      newStart,
      newCount,
      lines,
    });
  }

  if (value.kind === 'complete') {
    if ((declaredAdditions !== null && declaredAdditions !== computedAdditions) ||
        (declaredDeletions !== null && declaredDeletions !== computedDeletions) ||
        (status === 'created' && computedDeletions !== 0) ||
        (status === 'deleted' && computedAdditions !== 0)) return null;
    return {
      preview: { kind: 'complete', hunks },
      additions: declaredAdditions ?? computedAdditions,
      deletions: declaredDeletions ?? computedDeletions,
      bytes: byteLength,
      tooLarge: false,
    };
  }

  return {
    preview: { kind: 'partial', hunks },
    additions: declaredAdditions,
    deletions: declaredDeletions,
    bytes: byteLength,
    tooLarge: false,
  };
}

/** Validates untrusted Demo summaries and structured patch fixtures, projecting only display-safe fields. */
export function projectDemoAgentChanges(summaries: unknown, fixtureValue?: unknown): AgentChangeProjection {
  if (!Array.isArray(summaries)) return { ok: false, reason: 'invalid-change-set' };
  if (summaries.length > MAX_AGENT_CHANGE_FILES) {
    return { ok: false, reason: 'too-many-files' };
  }
  const safeSummaries = projectSummaries(summaries);
  if (!safeSummaries) return { ok: false, reason: 'invalid-change-set' };

  let fixtureFiles: unknown[] = [];
  if (fixtureValue !== undefined) {
    if (!isRecord(fixtureValue) || fixtureValue.provenance !== 'demo-fixture' ||
        !Array.isArray(fixtureValue.files) || fixtureValue.files.length > MAX_AGENT_CHANGE_FILES) {
      return { ok: false, reason: 'invalid-change-set' };
    }
    fixtureFiles = fixtureValue.files;
  }

  const fixturesByPath = new Map<string, Record<string, unknown>>();
  for (const item of fixtureFiles) {
    if (!isRecord(item)) return { ok: false, reason: 'invalid-change-set' };
    const pathResult = validateWorkspaceRelativePath(item.path);
    if (!pathResult.ok || sanitizeUntrustedText(item.path as string) !== item.path || fixturesByPath.has(item.path as string) ||
        !safeSummaries.some((summary) => summary.path === item.path)) {
      return { ok: false, reason: 'invalid-change-set' };
    }
    fixturesByPath.set(item.path as string, item);
  }

  let retainedBytes = 0;
  const files: AgentChangeFile[] = [];
  for (const summary of safeSummaries) {
    const raw = fixturesByPath.get(summary.path);
    const defaultBefore = summary.status === 'created' ? 'No before file (Demo)' : 'Demo before revision unavailable';
    const defaultAfter = summary.status === 'deleted' ? 'No after file (Demo)' : 'Demo after revision unavailable';
    let beforeRevision = defaultBefore;
    let afterRevision = defaultAfter;
    let preview: AgentDiffPreview = {
      kind: 'unavailable',
      message: 'A complete structured diff is not available for this Demo summary.',
    };
    let additions = summary.additions;
    let deletions = summary.deletions;

    if (raw) {
      if (raw.status !== summary.status) return { ok: false, reason: 'invalid-change-set' };
      const before = cleanLabel(raw.beforeRevision);
      const after = cleanLabel(raw.afterRevision);
      if (!before || !after) return { ok: false, reason: 'invalid-change-set' };
      beforeRevision = before;
      afterRevision = after;
      const parsed = parsePreview(raw.preview, summary.path, summary.status, summary.additions, summary.deletions);
      if (!parsed) return { ok: false, reason: 'invalid-change-set' };
      preview = parsed.preview;
      if (parsed.tooLarge) {
        additions = summary.additions;
        deletions = summary.deletions;
      } else {
        additions = parsed.additions;
        deletions = parsed.deletions;
        if (parsed.preview.kind === 'unavailable' || parsed.preview.kind === 'binary') {
          additions = summary.additions;
          deletions = summary.deletions;
        }
        if (retainedBytes + parsed.bytes > MAX_AGENT_DIFF_BYTES_TOTAL) {
          preview = { kind: 'too-large', message: 'The combined Demo diff exceeds the safe retained-data budget.' };
          additions = summary.additions;
          deletions = summary.deletions;
        } else {
          retainedBytes += parsed.bytes;
        }
      }
    }

    files.push({
      key: summary.path,
      path: summary.path,
      status: summary.status,
      additions,
      deletions,
      provenance: 'Demo sample',
      beforeRevision,
      afterRevision,
      preview,
    });
  }

  return { ok: true, files };
}

export interface CopyableAgentDiff {
  readonly kind: 'patch' | 'excerpt';
  readonly text: string;
}

/** Builds a bounded clipboard representation from already validated, sanitized structured data. */
export function buildCopyableAgentDiff(file: AgentChangeFile): CopyableAgentDiff | null {
  if (file.preview.kind !== 'complete' && file.preview.kind !== 'partial') return null;
  const lines: string[] = [];
  if (file.preview.kind === 'partial') {
    lines.push('# Partial Demo excerpt; omitted source is not included and this is not a complete or applicable patch.');
  } else {
    lines.push('# Demo sample patch; this is not a persisted Cloud Agent revision.');
  }
  lines.push(`# Before: ${file.beforeRevision}`);
  lines.push(`# After: ${file.afterRevision}`);
  lines.push(`--- ${file.status === 'created' ? '/dev/null' : `a/${file.path}`}`);
  lines.push(`+++ ${file.status === 'deleted' ? '/dev/null' : `b/${file.path}`}`);
  for (const hunk of file.preview.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    for (const line of hunk.lines) {
      if (line.kind === 'no-newline') {
        lines.push(line.text);
      } else {
        lines.push(`${line.kind === 'context' ? ' ' : line.kind === 'addition' ? '+' : '-'}${line.text}`);
      }
    }
  }
  const text = lines.join('\n') + '\n';
  if (text.length > MAX_AGENT_DIFF_COPY_BYTES || countLineBytes(text) > MAX_AGENT_DIFF_COPY_BYTES) return null;
  return { kind: file.preview.kind === 'complete' ? 'patch' : 'excerpt', text };
}

export interface AgentSplitRow {
  readonly key: string;
  readonly before: AgentDiffLine | null;
  readonly after: AgentDiffLine | null;
}

/** O(n) row alignment; deletions and additions within a change block pair by order without inventing content. */
export function alignAgentDiffHunk(hunk: AgentDiffHunk): readonly AgentSplitRow[] {
  const rows: AgentSplitRow[] = [];
  let index = 0;
  while (index < hunk.lines.length) {
    const line = hunk.lines[index]!;
    if (line.kind === 'context') {
      rows.push({ key: line.key, before: line, after: line });
      index++;
      continue;
    }
    if (line.kind === 'no-newline') {
      rows.push({
        key: line.key,
        before: line.appliesTo === 'before' || line.appliesTo === 'both' ? line : null,
        after: line.appliesTo === 'after' || line.appliesTo === 'both' ? line : null,
      });
      index++;
      continue;
    }

    const deletions: AgentDiffLine[] = [];
    const additions: AgentDiffLine[] = [];
    while (index < hunk.lines.length && hunk.lines[index]!.kind !== 'context' && hunk.lines[index]!.kind !== 'no-newline') {
      const changed = hunk.lines[index]!;
      if (changed.kind === 'deletion') deletions.push(changed);
      else additions.push(changed);
      index++;
    }
    const pairCount = Math.max(deletions.length, additions.length);
    for (let pair = 0; pair < pairCount; pair++) {
      const before = deletions[pair] ?? null;
      const after = additions[pair] ?? null;
      rows.push({ key: before?.key ?? after!.key, before, after });
    }
  }
  return rows;
}

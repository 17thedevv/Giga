import { describe, expect, it } from 'vitest';
import {
  alignAgentDiffHunk,
  buildCopyableAgentDiff,
  MAX_AGENT_DIFF_BYTES_PER_FILE,
  MAX_AGENT_DIFF_LINES,
  MAX_AGENT_DIFF_LINE_LENGTH,
  projectDemoAgentChanges,
} from '../src/features/agent/agent-diff-model.js';

function fixture(path: string, status: 'created' | 'modified' | 'deleted', preview: unknown, _additions?: number, _deletions?: number) {
  return {
    provenance: 'demo-fixture',
    files: [{ path, status, beforeRevision: 'Demo revision A', afterRevision: 'Demo revision B', preview }],
  };
}

function summarize(path: string, status: 'created' | 'modified' | 'deleted', additions?: number, deletions?: number) {
  return [{ path, status, ...(additions === undefined ? {} : { additions }), ...(deletions === undefined ? {} : { deletions }) }];
}

function hunk(oldStart: number, oldCount: number, newStart: number, newCount: number, lines: unknown[]) {
  return { oldStart, oldCount, newStart, newCount, lines };
}

function fileFrom(summaries: unknown, sample: unknown, index = 0) {
  const result = projectDemoAgentChanges(summaries, sample);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected a valid projected change set');
  return result.files[index]!;
}

describe('Agent structured diff projection', () => {
  it('projects a complete added file and derives line numbers and counts', () => {
    const summary = summarize('src/new.ts', 'created', 2, 0);
    const sample = fixture('src/new.ts', 'created', {
      kind: 'complete',
      hunks: [hunk(0, 0, 1, 2, [
        { kind: 'addition', text: 'export const hello = "hi";' },
        { kind: 'addition', text: '' },
      ])],
    }, 2, 0);
    const file = fileFrom(summary, sample);
    expect(file.status).toBe('created');
    expect(file.preview.kind).toBe('complete');
    if (file.preview.kind !== 'complete') return;
    expect(file.preview.hunks[0]?.lines.map((line) => [line.oldLine, line.newLine])).toEqual([[null, 1], [null, 2]]);
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(0);
  });

  it('projects modified and deleted files without inventing the missing side', () => {
    const modified = fileFrom(summarize('cfg/app.json', 'modified', 1, 1), fixture('cfg/app.json', 'modified', {
      kind: 'complete', hunks: [hunk(4, 1, 4, 1, [
        { kind: 'deletion', text: '  "mode": "old"' },
        { kind: 'addition', text: '  "mode": "new"' },
      ])],
    }, 1, 1));
    expect(modified.status).toBe('modified');
    expect(modified.additions).toBe(1);
    expect(modified.deletions).toBe(1);

    const deleted = fileFrom(summarize('docs/retired.md', 'deleted', 0, 2), fixture('docs/retired.md', 'deleted', {
      kind: 'complete', hunks: [hunk(1, 2, 0, 0, [
        { kind: 'deletion', text: '# Retired' },
        { kind: 'deletion', text: 'Old instructions.' },
      ])],
    }, 0, 2));
    expect(deleted.status).toBe('deleted');
    expect(deleted.preview.kind).toBe('complete');
    expect(deleted.beforeRevision).toBe('Demo revision A');
    expect(deleted.afterRevision).toBe('Demo revision B');
  });

  it('enforces created and deleted side invariants for complete and partial patches', () => {
    const invalidPatches: Array<{ name: string; status: 'created' | 'deleted'; preview: unknown }> = [
      {
        name: 'created context line', status: 'created',
        preview: { kind: 'complete', hunks: [hunk(0, 0, 1, 1, [{ kind: 'context', text: 'old' }])] },
      },
      {
        name: 'created deletion line', status: 'created',
        preview: { kind: 'complete', hunks: [hunk(0, 0, 1, 1, [{ kind: 'deletion', text: 'old' }])] },
      },
      {
        name: 'created nonzero old range', status: 'created',
        preview: { kind: 'complete', hunks: [hunk(1, 1, 2, 1, [{ kind: 'addition', text: 'new' }])] },
      },
      {
        name: 'created partial with old-side context', status: 'created',
        preview: { kind: 'partial', hunks: [hunk(0, 0, 1, 1, [{ kind: 'context', text: 'old' }])] },
      },
      {
        name: 'created no-newline marker on the missing before side', status: 'created',
        preview: { kind: 'complete', hunks: [hunk(0, 0, 1, 1, [
          { kind: 'addition', text: 'new' }, { kind: 'no-newline', appliesTo: 'before' },
        ])] },
      },
      {
        name: 'deleted context line', status: 'deleted',
        preview: { kind: 'complete', hunks: [hunk(1, 1, 0, 0, [{ kind: 'context', text: 'old' }])] },
      },
      {
        name: 'deleted addition line', status: 'deleted',
        preview: { kind: 'complete', hunks: [hunk(1, 1, 0, 0, [{ kind: 'addition', text: 'new' }])] },
      },
      {
        name: 'deleted nonzero new range', status: 'deleted',
        preview: { kind: 'complete', hunks: [hunk(1, 1, 1, 1, [{ kind: 'deletion', text: 'old' }])] },
      },
      {
        name: 'deleted partial with new-side content', status: 'deleted',
        preview: { kind: 'partial', hunks: [hunk(1, 1, 0, 0, [{ kind: 'addition', text: 'new' }])] },
      },
      {
        name: 'deleted no-newline marker on the missing after side', status: 'deleted',
        preview: { kind: 'complete', hunks: [hunk(1, 1, 0, 0, [
          { kind: 'deletion', text: 'old' }, { kind: 'no-newline', appliesTo: 'after' },
        ])] },
      },
    ];

    for (const [index, invalid] of invalidPatches.entries()) {
      const result = projectDemoAgentChanges(
        summarize(`src/invalid-${index}.ts`, invalid.status),
        fixture(`src/invalid-${index}.ts`, invalid.status, invalid.preview),
      );
      expect(result, invalid.name).toEqual({ ok: false, reason: 'invalid-change-set' });
      expect(result.ok ? result.files.map(buildCopyableAgentDiff) : [], invalid.name).toEqual([]);
    }
  });

  it('accepts valid created, deleted, and modified content only on available sides', () => {
    const created = fileFrom(summarize('src/new.ts', 'created', 1, 0), fixture('src/new.ts', 'created', {
      kind: 'complete', hunks: [hunk(0, 0, 1, 1, [
        { kind: 'addition', text: 'new file' },
        { kind: 'no-newline', appliesTo: 'after' },
      ])],
    }));
    expect(created.preview.kind).toBe('complete');
    expect(buildCopyableAgentDiff(created)?.text).toContain('--- /dev/null');

    const deleted = fileFrom(summarize('src/old.ts', 'deleted', 0, 1), fixture('src/old.ts', 'deleted', {
      kind: 'complete', hunks: [hunk(1, 1, 0, 0, [
        { kind: 'deletion', text: 'old file' },
        { kind: 'no-newline', appliesTo: 'before' },
      ])],
    }));
    expect(deleted.preview.kind).toBe('complete');
    expect(buildCopyableAgentDiff(deleted)?.text).toContain('+++ /dev/null');

    const modified = fileFrom(summarize('src/changed.ts', 'modified', 1, 1), fixture('src/changed.ts', 'modified', {
      kind: 'complete', hunks: [hunk(1, 2, 1, 2, [
        { kind: 'context', text: 'head' },
        { kind: 'deletion', text: 'old' },
        { kind: 'addition', text: 'new' },
      ])],
    }));
    expect(modified.preview.kind).toBe('complete');
    expect(modified.preview.kind === 'complete' && modified.preview.hunks[0]?.lines.map((line) => [line.oldLine, line.newLine]))
      .toEqual([[1, 1], [2, null], [null, 2]]);
  });

  it('requires exact string statuses and never projects coercible values', () => {
    const invalidStatuses: unknown[] = [
      ['created'], ['deleted'], ['modified'], {}, null, undefined, 123, true, 'CREATED', 'created ',
    ];
    for (const [index, status] of invalidStatuses.entries()) {
      const result = projectDemoAgentChanges([{ path: `src/invalid-status-${index}.ts`, status }]);
      expect(result, `status ${JSON.stringify(status)}`).toEqual({ ok: false, reason: 'invalid-change-set' });
      expect(result.ok ? result.files.map(buildCopyableAgentDiff) : []).toEqual([]);
    }

    for (const status of ['created', 'modified', 'deleted'] as const) {
      const result = projectDemoAgentChanges([{ path: `src/${status}.ts`, status }]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.files[0]?.status).toBe(status);
    }
  });

  it('validates multiple hunks and assigns monotonically correct old and new line numbers', () => {
    const file = fileFrom(summarize('src/multi.ts', 'modified', 2, 1), fixture('src/multi.ts', 'modified', {
      kind: 'complete', hunks: [
        hunk(2, 2, 2, 3, [
          { kind: 'context', text: 'const first = 1;' },
          { kind: 'deletion', text: 'const second = 2;' },
          { kind: 'addition', text: 'const second = 3;' },
          { kind: 'addition', text: 'const third = 4;' },
        ]),
        hunk(12, 1, 13, 1, [{ kind: 'context', text: 'export {};' }]),
      ],
    }, 2, 1));
    expect(file.preview.kind).toBe('complete');
    if (file.preview.kind !== 'complete') return;
    expect(file.preview.hunks.map((part) => [part.oldStart, part.oldCount, part.newStart, part.newCount])).toEqual([[2, 2, 2, 3], [12, 1, 13, 1]]);
    expect(file.preview.hunks[0]?.lines.map((line) => [line.oldLine, line.newLine])).toEqual([[2, 2], [3, null], [null, 3], [null, 4]]);
    expect(file.preview.hunks[1]?.lines[0]).toMatchObject({ oldLine: 12, newLine: 13 });
  });

  it('accepts complete multi-hunk patches with matching omitted spans and represented shifts', () => {
    const additions = fileFrom(summarize('src/add-shift.ts', 'modified', 1, 0), fixture('src/add-shift.ts', 'modified', {
      kind: 'complete', hunks: [
        hunk(1, 1, 1, 2, [
          { kind: 'context', text: 'before addition' },
          { kind: 'addition', text: 'inserted' },
        ]),
        hunk(5, 1, 6, 1, [{ kind: 'context', text: 'after addition' }]),
      ],
    }));
    expect(additions.preview.kind).toBe('complete');
    if (additions.preview.kind === 'complete') {
      expect(additions.preview.hunks[1]?.lines[0]).toMatchObject({ oldLine: 5, newLine: 6 });
    }

    const deletions = fileFrom(summarize('src/delete-shift.ts', 'modified', 0, 1), fixture('src/delete-shift.ts', 'modified', {
      kind: 'complete', hunks: [
        hunk(1, 2, 1, 1, [
          { kind: 'deletion', text: 'removed' },
          { kind: 'context', text: 'kept' },
        ]),
        hunk(6, 1, 5, 1, [{ kind: 'context', text: 'after deletion' }]),
      ],
    }));
    expect(deletions.preview.kind).toBe('complete');
    if (deletions.preview.kind === 'complete') {
      expect(deletions.preview.hunks[1]?.lines[0]).toMatchObject({ oldLine: 6, newLine: 5 });
    }

    const equalGaps = fileFrom(summarize('src/equal-gaps.ts', 'modified', 0, 0), fixture('src/equal-gaps.ts', 'modified', {
      kind: 'complete', hunks: [
        hunk(2, 1, 2, 1, [{ kind: 'context', text: 'first' }]),
        hunk(5, 1, 5, 1, [{ kind: 'context', text: 'later' }]),
      ],
    }));
    expect(equalGaps.preview.kind).toBe('complete');

    const zeroCountInsertion = fileFrom(summarize('src/insert-boundary.ts', 'modified', 1, 0), fixture('src/insert-boundary.ts', 'modified', {
      kind: 'complete', hunks: [
        hunk(4, 0, 5, 1, [{ kind: 'addition', text: 'inserted between ranges' }]),
        hunk(10, 1, 11, 1, [{ kind: 'context', text: 'later' }]),
      ],
    }));
    expect(zeroCountInsertion.preview.kind).toBe('complete');

    const zeroCountDeletion = fileFrom(summarize('src/delete-boundary.ts', 'modified', 0, 1), fixture('src/delete-boundary.ts', 'modified', {
      kind: 'complete', hunks: [
        hunk(5, 1, 4, 0, [{ kind: 'deletion', text: 'removed between ranges' }]),
        hunk(10, 1, 9, 1, [{ kind: 'context', text: 'later' }]),
      ],
    }));
    expect(zeroCountDeletion.preview.kind).toBe('complete');
  });

  it('rejects complete patches with unequal, overlapping, or decreasing hunk ranges without making them copyable', () => {
    const invalidHunks = [
      [
        hunk(1, 1, 1, 2, [{ kind: 'context', text: 'first' }, { kind: 'addition', text: 'new' }]),
        hunk(5, 1, 7, 1, [{ kind: 'context', text: 'later' }]),
      ],
      [
        hunk(1, 2, 1, 2, [{ kind: 'context', text: 'first' }, { kind: 'context', text: 'second' }]),
        hunk(2, 1, 2, 1, [{ kind: 'context', text: 'overlap' }]),
      ],
      [
        hunk(10, 1, 10, 1, [{ kind: 'context', text: 'first' }]),
        hunk(2, 1, 2, 1, [{ kind: 'context', text: 'decreasing' }]),
      ],
    ];

    for (const [index, hunks] of invalidHunks.entries()) {
      const result = projectDemoAgentChanges(
        summarize(`src/inconsistent-${index}.ts`, 'modified'),
        fixture(`src/inconsistent-${index}.ts`, 'modified', { kind: 'complete', hunks }),
      );
      expect(result).toEqual({ ok: false, reason: 'invalid-change-set' });
      expect(result.ok ? result.files.map(buildCopyableAgentDiff) : []).toEqual([]);
    }
  });

  it('keeps unequal omitted spans on legitimate partial excerpts explicitly partial', () => {
    const partial = fileFrom(summarize('src/partial-gaps.ts', 'modified', 1, 0), fixture('src/partial-gaps.ts', 'modified', {
      kind: 'partial', hunks: [
        hunk(1, 1, 1, 2, [
          { kind: 'context', text: 'before change' },
          { kind: 'addition', text: 'omitted change' },
        ]),
        hunk(5, 1, 7, 1, [{ kind: 'context', text: 'after change' }]),
      ],
    }));
    expect(partial.preview.kind).toBe('partial');
    expect(buildCopyableAgentDiff(partial)?.kind).toBe('excerpt');
    expect(buildCopyableAgentDiff(partial)?.text).toContain('not a complete or applicable patch');
  });

  it('copies valid complete multi-hunk patches with complete provenance and valid shifted coordinates', () => {
    const file = fileFrom(summarize('src/multi-copy.ts', 'modified', 1, 0), fixture('src/multi-copy.ts', 'modified', {
      kind: 'complete', hunks: [
        hunk(1, 1, 1, 2, [
          { kind: 'context', text: 'before' },
          { kind: 'addition', text: 'inserted' },
        ]),
        hunk(5, 1, 6, 1, [{ kind: 'context', text: 'after' }]),
      ],
    }));
    const copied = buildCopyableAgentDiff(file);
    expect(copied?.kind).toBe('patch');
    expect(copied?.text).toContain('Demo sample patch');
    expect(copied?.text).not.toContain('Partial Demo excerpt');
    expect(copied?.text).toContain('@@ -5,1 +6,1 @@');
  });

  it('keeps identical basenames in distinct directories as separate file identities', () => {
    const summaries = [
      ...summarize('src/components/index.ts', 'created', 1, 0),
      ...summarize('src/utils/index.ts', 'created', 1, 0),
    ];
    const result = projectDemoAgentChanges(summaries);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.files.map((file) => file.key)).toEqual(['src/components/index.ts', 'src/utils/index.ts']);
  });

  it('preserves Unicode paths, text, and whitespace as escaped React-ready data', () => {
    const file = fileFrom(summarize('docs/Chào Giga.md', 'created', 1, 0), fixture('docs/Chào Giga.md', 'created', {
      kind: 'complete', hunks: [hunk(0, 0, 1, 1, [{ kind: 'addition', text: '  Xin chào 👋  ' }])],
    }, 1, 0));
    expect(file.path).toBe('docs/Chào Giga.md');
    expect(file.preview.kind === 'complete' && file.preview.hunks[0]?.lines[0]?.text).toBe('  Xin chào 👋  ');
  });

  it.each([
    '../escape.ts',
    'src/../../escape.ts',
    '/etc/passwd',
    'C:/private/file.ts',
    '\\\\server\\share\\file.ts',
    'src\\file.ts',
    'src/invalid\u0000.ts',
  ])('rejects unsafe workspace path %s', (path) => {
    expect(projectDemoAgentChanges(summarize(path, 'created'))).toEqual({ ok: false, reason: 'invalid-change-set' });
  });

  it('rejects credential-shaped paths instead of echoing them into DOM identifiers or copied patches', () => {
    expect(projectDemoAgentChanges(summarize('src/ghp_123456789012345678901234567890.ts', 'created')))
      .toEqual({ ok: false, reason: 'invalid-change-set' });
  });

  it('rejects duplicate identities, file-parent collisions, and fixture summary mismatches atomically', () => {
    expect(projectDemoAgentChanges([
      ...summarize('src/a.ts', 'created'),
      ...summarize('src/a.ts', 'created'),
    ])).toEqual({ ok: false, reason: 'invalid-change-set' });
    expect(projectDemoAgentChanges([
      ...summarize('src', 'created'),
      ...summarize('src/a.ts', 'created'),
    ])).toEqual({ ok: false, reason: 'invalid-change-set' });
    expect(projectDemoAgentChanges(summarize('x.ts', 'created', 1, 0), fixture('x.ts', 'created', {
      kind: 'complete', hunks: [hunk(0, 0, 1, 2, [
        { kind: 'addition', text: 'line' }, { kind: 'addition', text: 'another' },
      ])],
    }, 2, 0))).toEqual({ ok: false, reason: 'invalid-change-set' });
  });

  it('rejects malformed hunk counts, ordering, empty structures, and contradictory complete totals', () => {
    expect(projectDemoAgentChanges(summarize('x.ts', 'modified'), fixture('x.ts', 'modified', {
      kind: 'complete', hunks: [hunk(1, 4, 1, 1, [{ kind: 'deletion', text: 'x' }])],
    }))).toEqual({ ok: false, reason: 'invalid-change-set' });
    expect(projectDemoAgentChanges(summarize('x.ts', 'created'), fixture('x.ts', 'created', {
      kind: 'complete', hunks: [hunk(0, 1, 1, 1, [{ kind: 'context', text: 'x' }])],
    }))).toEqual({ ok: false, reason: 'invalid-change-set' });
    expect(projectDemoAgentChanges(summarize('x.ts', 'modified'), fixture('x.ts', 'modified', {
      kind: 'complete', hunks: [
        hunk(10, 1, 10, 1, [{ kind: 'context', text: 'x' }]),
        hunk(1, 1, 1, 1, [{ kind: 'context', text: 'y' }]),
      ],
    }))).toEqual({ ok: false, reason: 'invalid-change-set' });
    expect(projectDemoAgentChanges(summarize('x.ts', 'modified', 9, 0), fixture('x.ts', 'modified', {
      kind: 'complete', hunks: [hunk(1, 1, 1, 2, [
        { kind: 'context', text: 'x' }, { kind: 'addition', text: 'y' },
      ])],
    }, 1, 0))).toEqual({ ok: false, reason: 'invalid-change-set' });
  });

  it('allows declared summary counts to exceed an explicitly partial excerpt and exposes it as partial', () => {
    const file = fileFrom(summarize('src/partial.ts', 'created', 500, 0), fixture('src/partial.ts', 'created', {
      kind: 'partial', hunks: [hunk(0, 0, 1, 1, [{ kind: 'addition', text: 'export const visible = true;' }])],
    }, 500, 0));
    expect(file.preview.kind).toBe('partial');
    expect(file.additions).toBe(500);
  });

  it('represents unavailable and binary content without treating them as empty files', () => {
    const summaries = [
      ...summarize('src/no-patch.ts', 'created', 4, 0),
      ...summarize('assets/image.png', 'modified'),
    ];
    const sample = {
      provenance: 'demo-fixture',
      files: [
        { path: 'assets/image.png', status: 'modified', beforeRevision: 'Demo A', afterRevision: 'Demo B', preview: { kind: 'binary' } },
      ],
    };
    const result = projectDemoAgentChanges(summaries, sample);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files[0]?.preview).toMatchObject({ kind: 'unavailable' });
      expect(result.files[0]?.additions).toBe(4);
      expect(result.files[1]?.preview.kind).toBe('binary');
    }
  });

  it('sanitizes credentials, strips terminal controls, and never retains unknown private metadata', () => {
    const raw = fixture('src/safe.ts', 'created', {
      kind: 'complete',
      workerLeaseToken: 'internal-lease-value',
      hunks: [hunk(0, 0, 1, 1, [{ kind: 'addition', text: 'const key = "AIzaSyDUMMYSECRET12345678901234567890";\u001b[31m' }])],
    }, 1, 0) as Record<string, unknown>;
    raw.privateFields = { workerLeaseToken: 'internal-lease-value', reasoning: 'private' };
    const file = fileFrom(summarize('src/safe.ts', 'created', 1, 0), raw);
    const serialized = JSON.stringify(file);
    expect(serialized).not.toContain('AIzaSyDUMMYSECRET12345678901234567890');
    expect(serialized).not.toContain('internal-lease-value');
    expect(serialized).not.toContain('reasoning');
    expect(serialized).toContain('[redacted');
  });

  it('rejects mixed line endings embedded in a single structured line instead of repairing them', () => {
    expect(projectDemoAgentChanges(summarize('src/eol.ts', 'created', 1, 0), fixture('src/eol.ts', 'created', {
      kind: 'complete', hunks: [hunk(0, 0, 1, 1, [{ kind: 'addition', text: 'one\r\ntwo' }])],
    }, 1, 0))).toEqual({ ok: false, reason: 'invalid-change-set' });
  });

  it('bounds newline-dense rows, line lengths, per-file bytes, and total files', () => {
    const manyLines = Array.from({ length: MAX_AGENT_DIFF_LINES + 1 }, () => ({ kind: 'addition', text: 'x' }));
    const lineLimited = fileFrom(summarize('src/many.ts', 'created'), fixture('src/many.ts', 'created', {
      kind: 'partial', hunks: [hunk(0, 0, 1, manyLines.length, manyLines)],
    }));
    expect(lineLimited.preview.kind).toBe('too-large');

    const longLine = fileFrom(summarize('src/long.ts', 'created'), fixture('src/long.ts', 'created', {
      kind: 'partial', hunks: [hunk(0, 0, 1, 1, [{ kind: 'addition', text: 'x'.repeat(MAX_AGENT_DIFF_LINE_LENGTH + 1) }])],
    }));
    expect(longLine.preview.kind).toBe('too-large');

    const byteLimited = fileFrom(summarize('src/bytes.ts', 'created'), fixture('src/bytes.ts', 'created', {
      kind: 'partial', hunks: [hunk(0, 0, 1, 9, Array.from({ length: 9 }, () => ({ kind: 'addition', text: 'x'.repeat(8000) })))],
    }));
    expect(byteLimited.preview.kind).toBe('too-large');
    expect(MAX_AGENT_DIFF_BYTES_PER_FILE).toBe(64 * 1024);
    const hunkLimited = fileFrom(summarize('src/hunks.ts', 'created'), fixture('src/hunks.ts', 'created', {
      kind: 'partial', hunks: Array.from({ length: 81 }, (_, index) => hunk(0, 0, index + 1, 1, [{ kind: 'addition', text: 'x' }])),
    }));
    expect(hunkLimited.preview.kind).toBe('too-large');
    const tooMany = projectDemoAgentChanges(Array.from({ length: 101 }, (_, index) => ({ path: `f${index}.ts`, status: 'created' })));
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.reason).toBe('too-many-files');
  });

  it('keeps complete additions/deletions consistent and emits a labeled bounded partial excerpt', () => {
    const file = fileFrom(summarize('src/a.ts', 'modified', 1, 1), fixture('src/a.ts', 'modified', {
      kind: 'complete', hunks: [hunk(1, 1, 1, 1, [
        { kind: 'deletion', text: 'const token = "ghp_123456789012345678901234567890";' },
        { kind: 'addition', text: 'const label = "safe";' },
      ])],
    }, 1, 1));
    const copied = buildCopyableAgentDiff(file);
    expect(copied?.kind).toBe('patch');
    expect(copied?.text).toContain('Demo sample patch');
    expect(copied?.text).not.toContain('ghp_123456789012345678901234567890');

    const partial = fileFrom(summarize('src/p.ts', 'created', 8, 0), fixture('src/p.ts', 'created', {
      kind: 'partial', hunks: [hunk(0, 0, 1, 1, [{ kind: 'addition', text: 'sample' }])],
    }, 8, 0));
    expect(buildCopyableAgentDiff(partial)).toMatchObject({ kind: 'excerpt' });
    expect(buildCopyableAgentDiff(partial)?.text).toContain('not a complete or applicable patch');
  });

  it('serializes no-final-newline markers and refuses copy for unavailable data', () => {
    const file = fileFrom(summarize('src/no-eol.ts', 'created', 1, 0), fixture('src/no-eol.ts', 'created', {
      kind: 'complete', hunks: [hunk(0, 0, 1, 1, [
        { kind: 'addition', text: 'export {};' }, { kind: 'no-newline', appliesTo: 'after' },
      ])],
    }, 1, 0));
    expect(buildCopyableAgentDiff(file)?.text).toContain('\\ No newline at end of file');
    const unavailable = fileFrom(summarize('src/no.ts', 'created'), undefined);
    expect(buildCopyableAgentDiff(unavailable)).toBeNull();
  });

  it('rejects copying when a complete patch exceeds the dedicated clipboard budget', () => {
    const bigLines = Array.from({ length: 5 }, (_, index) => ({ kind: 'addition', text: `${index}:` + 'x'.repeat(7000) }));
    const file = fileFrom(summarize('src/copy-budget.ts', 'created', 5, 0), fixture('src/copy-budget.ts', 'created', {
      kind: 'complete', hunks: [hunk(0, 0, 1, 5, bigLines)],
    }, 5, 0));
    expect(file.preview.kind).toBe('complete');
    expect(buildCopyableAgentDiff(file)).toBeNull();
  });

  it('projects only known display fields from nested unknown objects', () => {
    const summaries = [{ path: 'src/a.ts', status: 'created', additions: 1, deletions: 0, providerSecret: 'do-not-retain' }];
    const file = fileFrom(summaries, fixture('src/a.ts', 'created', {
      kind: 'complete', internalReasoning: 'do-not-retain', hunks: [hunk(0, 0, 1, 1, [{ kind: 'addition', text: 'safe' }])],
    }, 1, 0));
    expect(JSON.stringify(file)).not.toContain('do-not-retain');
    expect(Object.keys(file)).toEqual(['key', 'path', 'status', 'additions', 'deletions', 'provenance', 'beforeRevision', 'afterRevision', 'preview']);
  });

  it('aligns additions and deletions linearly while leaving unmatched counterpart cells empty', () => {
    const file = fileFrom(summarize('src/align.ts', 'modified', 2, 1), fixture('src/align.ts', 'modified', {
      kind: 'complete', hunks: [hunk(1, 3, 1, 4, [
        { kind: 'context', text: 'head' },
        { kind: 'deletion', text: 'old' },
        { kind: 'addition', text: 'new' },
        { kind: 'addition', text: 'second new' },
        { kind: 'context', text: 'tail' },
      ])],
    }, 2, 1));
    expect(file.preview.kind).toBe('complete');
    if (file.preview.kind !== 'complete') return;
    const rows = alignAgentDiffHunk(file.preview.hunks[0]!);
    expect(rows.map((row) => [row.before?.text ?? null, row.after?.text ?? null])).toEqual([
      ['head', 'head'], ['old', 'new'], [null, 'second new'], ['tail', 'tail'],
    ]);
  });
});

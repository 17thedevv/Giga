import { describe, expect, it } from 'vitest';
import {
  buildAgentFileTree,
  MAX_AGENT_FILE_PATH_DEPTH,
  MAX_AGENT_FILE_PATH_LENGTH,
  MAX_AGENT_PREVIEW_BYTES,
  projectDemoWorkspaceSnapshot,
  validateWorkspaceRelativePath,
} from '../src/features/agent/agent-file-model.js';

function snapshot(entries: unknown[], extra: Record<string, unknown> = {}) {
  return {
    workspaceId: 'ws-demo-test',
    snapshotId: 'sample-r1',
    provenance: 'demo-fixture',
    partial: false,
    entries,
    ...extra,
  };
}

function textFile(path: string, content = 'sample') {
  return { path, kind: 'file', sizeBytes: new TextEncoder().encode(content).byteLength, preview: { kind: 'text', content } };
}

function project(input: unknown) {
  return projectDemoWorkspaceSnapshot(input);
}

describe('Agent Demo file snapshot model', () => {
  it('accepts a canonical workspace-relative file path', () => {
    expect(validateWorkspaceRelativePath('src/components/Button.tsx').ok).toBe(true);
  });

  it('rejects parent traversal at the beginning or inside a path', () => {
    expect(validateWorkspaceRelativePath('../secret.txt').ok).toBe(false);
    expect(validateWorkspaceRelativePath('src/../secret.txt').ok).toBe(false);
  });

  it('rejects absolute POSIX paths', () => {
    expect(validateWorkspaceRelativePath('/etc/passwd').ok).toBe(false);
  });

  it('rejects Windows drive paths, including drive-relative paths', () => {
    expect(validateWorkspaceRelativePath('C:\\Users\\name\\file.ts').ok).toBe(false);
    expect(validateWorkspaceRelativePath('D:relative\\file.ts').ok).toBe(false);
  });

  it('rejects UNC paths and all backslash separators', () => {
    expect(validateWorkspaceRelativePath('\\\\server\\share\\file.txt').ok).toBe(false);
    expect(validateWorkspaceRelativePath('src\\file.txt').ok).toBe(false);
  });

  it('rejects NUL and other control characters', () => {
    expect(validateWorkspaceRelativePath('src/fi\u0000le.ts').ok).toBe(false);
    expect(validateWorkspaceRelativePath('src/fi\nle.ts').ok).toBe(false);
    expect(validateWorkspaceRelativePath('src/fi\u0085le.ts').ok).toBe(false);
  });

  it('rejects dot segments, empty segments and ambiguous separators', () => {
    for (const path of ['./file.ts', 'src/./file.ts', 'src//file.ts', 'src/file.ts/', '']) {
      expect(validateWorkspaceRelativePath(path).ok, path).toBe(false);
    }
  });

  it('preserves Unicode and meaningful whitespace in path identity', () => {
    const path = 'src/pages/ 你好 world .tsx';
    const result = validateWorkspaceRelativePath(path);
    expect(result).toEqual({ ok: true, segments: ['src', 'pages', ' 你好 world .tsx'] });
    const parsed = project(snapshot([textFile(path)]));
    expect(parsed.ok && parsed.snapshot.entries[0]?.path).toBe(path);
  });

  it('rejects excessive path depth and path length', () => {
    const deep = Array.from({ length: MAX_AGENT_FILE_PATH_DEPTH + 1 }, (_, index) => `d${index}`).join('/');
    expect(validateWorkspaceRelativePath(deep).ok).toBe(false);
    expect(validateWorkspaceRelativePath(`a/${'x'.repeat(MAX_AGENT_FILE_PATH_LENGTH)}`).ok).toBe(false);
  });

  it('rejects segments longer than the portable segment bound', () => {
    expect(validateWorkspaceRelativePath(`${'x'.repeat(256)}.txt`).ok).toBe(false);
  });

  it('rejects colon path syntax to avoid drive and stream ambiguity', () => {
    expect(validateWorkspaceRelativePath('folder/file:stream.txt').ok).toBe(false);
  });

  it('rejects duplicate canonical file paths without partially projecting entries', () => {
    const result = project(snapshot([textFile('src/a.ts'), textFile('src/a.ts')]));
    expect(result).toEqual({ ok: false, reason: 'invalid_snapshot' });
  });

  it('rejects canonical collisions rather than normalizing alternate spellings', () => {
    expect(project(snapshot([textFile('src/a.ts'), textFile('src//a.ts')])).ok).toBe(false);
    expect(project(snapshot([textFile('src/a.ts'), textFile('src/./a.ts')])).ok).toBe(false);
  });

  it.each([
    [textFile('src'), textFile('src/child.ts')],
    [textFile('src/child.ts'), textFile('src')],
  ])('rejects a file that collides with a directory path', (...entries) => {
    expect(project(snapshot(entries)).ok).toBe(false);
  });

  it('allows an explicit empty folder and an explicit parent with children', () => {
    const result = project(snapshot([{ path: 'empty', kind: 'folder' }, { path: 'src', kind: 'folder' }, textFile('src/app.ts')]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(buildAgentFileTree(result.snapshot.entries).map((node) => node.path)).toEqual(['empty', 'src']);
  });

  it('rejects malformed workspace or snapshot metadata', () => {
    expect(project(snapshot([], { workspaceId: '../host' })).ok).toBe(false);
    expect(project(snapshot([], { snapshotId: '' })).ok).toBe(false);
    expect(project({ ...snapshot([]), provenance: 'real-api' }).ok).toBe(false);
    expect(project({ ...snapshot([]), partial: 'yes' }).ok).toBe(false);
    expect(project({ ...snapshot([]), entries: 'not-an-array' }).ok).toBe(false);
  });

  it('rejects malformed entries, symlink-like records, and invalid size metadata', () => {
    expect(project(snapshot([null])).ok).toBe(false);
    expect(project(snapshot([{ path: 'escape', kind: 'symlink', target: '../../outside' }])).ok).toBe(false);
    expect(project(snapshot([{ path: 'file.txt', kind: 'file', sizeBytes: -1, preview: { kind: 'unavailable' } }])).ok).toBe(false);
    expect(project(snapshot([{ path: 'dir', kind: 'folder', sizeBytes: 0 }])).ok).toBe(false);
  });

  it('projects only public UI fields and drops unknown metadata', () => {
    const raw = snapshot([{ ...textFile('src/a.ts'), workerLeaseToken: 'synthetic-private-value' }], { internalSecret: 'synthetic-secret' });
    const result = project(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot).not.toHaveProperty('internalSecret');
      expect(result.snapshot.entries[0]).not.toHaveProperty('workerLeaseToken');
      expect(Object.keys(result.snapshot.entries[0] ?? {}).sort()).toEqual(['kind', 'path', 'preview', 'sizeBytes']);
    }
  });

  it('redacts credential-shaped source text before retaining a preview', () => {
    const result = project(snapshot([textFile('src/readme.md', 'api_key=syntheticSecretValue123456\nkeep this text')]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const preview = result.snapshot.entries[0];
      expect(preview?.kind === 'file' && preview.preview.kind === 'text' ? preview.preview.content : '').toContain('[redacted]');
      expect(preview?.kind === 'file' && preview.preview.kind === 'text' ? preview.preview.content : '').not.toContain('syntheticSecretValue123456');
    }
  });

  it('does not retain oversized preview content', () => {
    const giant = 'x'.repeat(MAX_AGENT_PREVIEW_BYTES + 20);
    const result = project(snapshot([{ path: 'src/large.txt', kind: 'file', sizeBytes: giant.length, preview: { kind: 'text', content: giant } }]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.entries[0]).toEqual({ path: 'src/large.txt', kind: 'file', sizeBytes: giant.length, preview: { kind: 'too-large' } });
  });

  it('bounds the retained text budget across a snapshot', () => {
    const contents = Array.from({ length: 9 }, (_, index) => textFile(`files/file-${index}.txt`, 'x'.repeat(60_000)));
    const result = project(snapshot(contents));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const last = result.snapshot.entries.at(-1);
      expect(last?.kind === 'file' && last.preview.kind).toBe('too-large');
    }
  });

  it('keeps duplicate basenames under different paths as separate identities', () => {
    const result = project(snapshot([textFile('src/components/Button.tsx', 'component'), textFile('src/pages/Button.tsx', 'page')]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const tree = buildAgentFileTree(result.snapshot.entries);
      expect(tree[0]?.kind).toBe('folder');
      const src = tree[0];
      expect(src?.kind === 'folder' ? src.children.map((node) => node.path) : []).toEqual(['src/components', 'src/pages']);
    }
  });

  it('sorts folders first and sorts sibling labels deterministically', () => {
    const result = project(snapshot([textFile('z.txt'), { path: 'z-folder', kind: 'folder' }, textFile('a.txt'), { path: 'A-folder', kind: 'folder' }]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(buildAgentFileTree(result.snapshot.entries).map((node) => node.path)).toEqual(['A-folder', 'z-folder', 'a.txt', 'z.txt']);
  });

  it('keeps deep folders nested without flattening path identity', () => {
    const path = 'src/pages/guides/reference/api/v2/examples/readme.md';
    const result = project(snapshot([textFile(path)]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      let nodes = buildAgentFileTree(result.snapshot.entries);
      for (const part of path.split('/').slice(0, -1)) {
        const folder = nodes.find((node) => node.name === part);
        expect(folder?.kind).toBe('folder');
        if (folder?.kind === 'folder') nodes = folder.children;
      }
      expect(nodes[0]?.path).toBe(path);
    }
  });

  it('uses a bounded finite entry count', () => {
    const entries = Array.from({ length: 2001 }, (_, index) => ({ path: `folder-${index}`, kind: 'folder' }));
    expect(project(snapshot(entries)).ok).toBe(false);
  });
});

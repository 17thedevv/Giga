import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildAgentFileTree,
  countAgentPreviewLines,
  languageForAgentFile,
  MAX_AGENT_PREVIEW_BYTES,
  MAX_AGENT_PREVIEW_LINES,
  projectDemoWorkspaceSnapshot,
  safeAgentFileDisplayText,
  type AgentFilePreview,
  type AgentFileTreeNode,
  type AgentSnapshotFile,
  type DemoWorkspaceSnapshot,
} from './agent-file-model.js';
import { realApiClient, ApiException, getSessionGeneration, isCurrentSessionGeneration, SESSION_EXPIRED_EVENT } from '../../lib/api/client.js';
import { isAgentCapabilityAvailable, readAgentCapabilities } from '../../lib/api/agent-contract.js';

interface FileTreeViewState {
  readonly identity: string;
  readonly search: string;
  readonly selectedPath: string | null;
  readonly expandedPaths: ReadonlySet<string>;
}

function collectNodes(nodes: readonly AgentFileTreeNode[], output: AgentFileTreeNode[] = []): AgentFileTreeNode[] {
  for (const node of nodes) {
    output.push(node);
    if (node.kind === 'folder') collectNodes(node.children, output);
  }
  return output;
}

function ancestors(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

function collectDescendants(folder: Extract<AgentFileTreeNode, { kind: 'folder' }>, visible: Set<string>): void {
  for (const child of folder.children) {
    visible.add(child.path);
    if (child.kind === 'folder') collectDescendants(child, visible);
  }
}

function displaySize(sizeBytes: number | null): string {
  if (sizeBytes === null) return 'Size unavailable';
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(sizeBytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(sizeBytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function placeholderFor(preview: AgentFilePreview): string | null {
  switch (preview.kind) {
    case 'text': return null;
    case 'binary': return 'This file is binary. A text preview is not available.';
    case 'too-large': return 'This file is too large for a safe in-browser preview.';
    case 'too-many-lines': return 'This file contains too many lines for the read-only preview.';
    case 'unsupported': return 'This file type is not supported by the source preview.';
    case 'unavailable': return 'File content is unavailable in this snapshot.';
    case 'error': return 'The source preview could not be loaded.';
  }
}

type SourcePreviewState =
  | { readonly kind: 'none' | 'empty' }
  | { readonly kind: 'placeholder'; readonly message: string; readonly testId: string }
  | { readonly kind: 'text'; readonly content: string; readonly lineCount: number };

function buildSourcePreviewState(file: AgentSnapshotFile | null): SourcePreviewState {
  if (!file) return { kind: 'none' };
  if (file.preview.kind !== 'text') {
    return { kind: 'placeholder', message: placeholderFor(file.preview) ?? 'Preview unavailable.', testId: `preview-${file.preview.kind}` };
  }

  const rawContent = file.preview.content;
  // `length` is a cheap lower bound on UTF-8 bytes; avoid encoding obviously oversized input.
  if (rawContent.length > MAX_AGENT_PREVIEW_BYTES || new TextEncoder().encode(rawContent).byteLength > MAX_AGENT_PREVIEW_BYTES) {
    return { kind: 'placeholder', message: 'This file is too large for a safe in-browser preview.', testId: 'preview-too-large' };
  }

  const lineCount = countAgentPreviewLines(rawContent);
  if (lineCount > MAX_AGENT_PREVIEW_LINES) {
    return {
      kind: 'placeholder',
      message: 'This file contains too many lines for the read-only preview.',
      testId: 'preview-too-many-lines',
    };
  }

  const content = safeAgentFileDisplayText(rawContent);
  return content.length ? { kind: 'text', content, lineCount } : { kind: 'empty' };
}

export const AgentSourcePreview: React.FC<{ file: AgentSnapshotFile | null }> = React.memo(({ file }) => {
  const previewState = useMemo(() => buildSourcePreviewState(file), [file]);
  const language = file ? languageForAgentFile(file.path) ?? 'Plain text' : null;
  const fileName = file ? safeAgentFileDisplayText(file.path.slice(file.path.lastIndexOf('/') + 1)) : null;
  const displayPath = file ? safeAgentFileDisplayText(file.path) : null;

  return (
    <section className="g-agent-source-preview" aria-labelledby="agent-source-preview-heading" data-testid="agent-source-preview">
      <header className="g-agent-source-preview__header">
        <div>
          <h3 id="agent-source-preview-heading">{fileName ?? 'Source preview'}</h3>
          {file ? <p aria-label="Selected file path">{displayPath}</p> : <p>Select a file to inspect its read-only Demo source.</p>}
        </div>
        {file && <dl><div><dt>Type</dt><dd>{language}</dd></div><div><dt>Size</dt><dd>{displaySize(file.sizeBytes)}</dd></div></dl>}
      </header>
      {previewState.kind === 'none' && <p className="g-agent-file-status" role="status">No file selected.</p>}
      {previewState.kind === 'placeholder' && <p className="g-agent-file-status" role="status" data-testid={previewState.testId}>{previewState.message}</p>}
      {previewState.kind === 'empty' && <p className="g-agent-file-status" role="status" data-testid="preview-empty">This text file is empty.</p>}
      {previewState.kind === 'text' && (
        <div className="g-agent-source-code" aria-label={`${language} source code`} data-testid="source-code-viewer">
          <ol aria-hidden="true">{Array.from({ length: previewState.lineCount }, (_, index) => <li key={index}>{index + 1}</li>)}</ol>
          <pre><code>{previewState.content}</code></pre>
        </div>
      )}
    </section>
  );
});

export const AgentFileExplorer: React.FC<{ snapshot: DemoWorkspaceSnapshot }> = ({ snapshot }) => {
  const identity = `${snapshot.workspaceId}\u0000${snapshot.snapshotId}`;
  const [viewState, setViewState] = useState<FileTreeViewState>(() => ({
    identity, search: '', selectedPath: null, expandedPaths: new Set(),
  }));
  const currentState = viewState.identity === identity
    ? viewState
    : { identity, search: '', selectedPath: null, expandedPaths: new Set<string>() };
  const projection = useMemo(() => projectDemoWorkspaceSnapshot(snapshot), [snapshot]);
  const tree = useMemo(() => projection.ok ? buildAgentFileTree(projection.snapshot.entries) : [], [projection]);
  const flatNodes = useMemo(() => collectNodes(tree), [tree]);
  const filesByPath = useMemo(() => new Map(flatNodes.filter((node): node is Extract<AgentFileTreeNode, { kind: 'file' }> => node.kind === 'file')
    .map((node) => [node.path, node])), [flatNodes]);

  useEffect(() => {
    setViewState({ identity, search: '', selectedPath: null, expandedPaths: new Set() });
  }, [identity]);

  const query = currentState.search.toLocaleLowerCase();
  const visiblePaths = useMemo(() => {
    if (!query) return null;
    const visible = new Set<string>();
    for (const node of flatNodes) {
      const safePath = safeAgentFileDisplayText(node.path).toLocaleLowerCase();
      if (!safePath.includes(query)) continue;
      visible.add(node.path);
      for (const parent of ancestors(node.path)) visible.add(parent);
      if (node.kind === 'folder') collectDescendants(node, visible);
    }
    return visible;
  }, [flatNodes, query]);
  const forcedExpanded = useMemo(() => {
    if (!visiblePaths) return new Set<string>();
    const expanded = new Set<string>();
    for (const path of visiblePaths) {
      for (const parent of ancestors(path)) expanded.add(parent);
    }
    return expanded;
  }, [visiblePaths]);

  if (!projection.ok) {
    return (
      <section className="g-agent-file-explorer" aria-labelledby="agent-files-heading" data-testid="agent-file-explorer">
        <h2 id="agent-files-heading">Files <span className="g-agent-file-demo-badge">Demo</span></h2>
        <p role="alert">This Demo snapshot could not be displayed because its metadata is invalid.</p>
      </section>
    );
  }

  const { snapshot: safeSnapshot } = projection;
  const selectedFile = currentState.selectedPath ? filesByPath.get(currentState.selectedPath) ?? null : null;

  const setSearch = (search: string) => setViewState((state) => ({ ...state, identity, search }));
  const toggleFolder = (path: string) => setViewState((state) => {
    const active = state.identity === identity ? state.expandedPaths : new Set<string>();
    const next = new Set(active);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return { ...(state.identity === identity ? state : currentState), identity, expandedPaths: next };
  });
  const selectFile = (path: string) => setViewState((state) => ({ ...state, identity, selectedPath: path }));
  const activateByKey = (event: React.KeyboardEvent<HTMLButtonElement>, action: () => void) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    action();
  };

  const renderNodes = (nodes: readonly AgentFileTreeNode[]): React.ReactNode => (
    <ul className="g-agent-file-tree__list">
      {nodes.filter((node) => !visiblePaths || visiblePaths.has(node.path)).map((node) => {
        const displayName = safeAgentFileDisplayText(node.name);
        if (node.kind === 'folder') {
          const expanded = currentState.expandedPaths.has(node.path) || forcedExpanded.has(node.path);
          return (
            <li key={node.path}>
              <button
                type="button"
                className="g-agent-file-tree__item g-agent-file-tree__folder"
                aria-expanded={expanded}
                aria-label={`${expanded ? 'Collapse' : 'Expand'} folder ${displayName}`}
                data-testid={`folder-${node.path}`}
                onClick={() => toggleFolder(node.path)}
                onKeyDown={(event) => activateByKey(event, () => toggleFolder(node.path))}
              >
                <span aria-hidden="true">{expanded ? '▾' : '▸'}</span><span>{displayName}</span>
              </button>
              {expanded && (node.children.length
                ? renderNodes(node.children)
                : <p className="g-agent-file-tree__empty-folder">Empty folder.</p>)}
            </li>
          );
        }
        const selected = currentState.selectedPath === node.path;
        return (
          <li key={node.path}>
            <button
              type="button"
              className={`g-agent-file-tree__item g-agent-file-tree__file${selected ? ' is-selected' : ''}`}
              aria-label={`Open file ${safeAgentFileDisplayText(node.path)}`}
              aria-pressed={selected}
              data-testid={`file-${node.path}`}
              onClick={() => selectFile(node.path)}
              onKeyDown={(event) => activateByKey(event, () => selectFile(node.path))}
            >
              <span aria-hidden="true">▤</span><span>{displayName}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  const searchHasResults = !currentState.search || Boolean(visiblePaths?.size);
  return (
    <section className="g-agent-file-explorer" aria-labelledby="agent-files-heading" data-testid="agent-file-explorer">
      <header className="g-agent-file-explorer__heading">
        <div><h2 id="agent-files-heading">File Explorer <span className="g-agent-file-demo-badge">Demo</span></h2>
          <p>Deterministic sample source for workspace {safeAgentFileDisplayText(safeSnapshot.workspaceId)}. It is not generated by this run or persisted Cloud content.</p>
        </div>
        <span className="g-agent-file-snapshot-label">Sample snapshot · {safeAgentFileDisplayText(safeSnapshot.snapshotId)}</span>
      </header>
      {safeSnapshot.partial && <p className="g-agent-file-status" role="status" data-testid="partial-snapshot-notice">This sample snapshot is partial; some file contents are unavailable.</p>}
      <div className="g-agent-file-explorer__panes">
        <section className="g-agent-file-tree" aria-label="Demo workspace files">
          <label className="g-agent-file-search" htmlFor="agent-file-search">
            <span>Search by filename or relative path</span>
            <input id="agent-file-search" type="search" value={currentState.search} onChange={(event) => setSearch(event.target.value)} />
          </label>
          <div className="g-agent-file-tree__scroll" data-testid="agent-file-tree">
            {!searchHasResults && <p className="g-agent-file-status" role="status" data-testid="file-search-empty">No files match this search.</p>}
            {searchHasResults && tree.length === 0 && <p className="g-agent-file-status" role="status">No files are included in this Demo snapshot.</p>}
            {searchHasResults && tree.length > 0 && renderNodes(tree)}
          </div>
        </section>
        <AgentSourcePreview file={selectedFile} />
      </div>
    </section>
  );
};

type RealFilesStatus = 'checking' | 'unsupported' | 'route-pending' | 'unverified' | 'session-expired';

/** Real mode deliberately has no file list/content request until 17T-74 is reviewed and shipped. */
export const AgentRealFilesPanel: React.FC<{ workspaceId: string }> = ({ workspaceId }) => {
  const [state, setState] = useState<{ identity: string; status: RealFilesStatus }>({ identity: workspaceId, status: 'checking' });
  const [retryNonce, setRetryNonce] = useState(0);
  const requestIdRef = useRef(0);
  const status = state.identity === workspaceId ? state.status : 'checking';

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    const session = getSessionGeneration();
    let active = true;
    setState({ identity: workspaceId, status: 'checking' });
    const expireSession = () => {
      if (active) setState({ identity: workspaceId, status: 'session-expired' });
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, expireSession);

    void realApiClient.getAgentCapabilities().then((response) => {
      if (!active || requestIdRef.current !== requestId || !isCurrentSessionGeneration(session)) return;
      const capabilities = readAgentCapabilities(response);
      const advertised = isAgentCapabilityAvailable(capabilities, 'sandboxFiles');
      // Capability discovery is not a route contract; never call guessed file endpoints.
      setState({ identity: workspaceId, status: advertised ? 'route-pending' : 'unsupported' });
    }).catch((error: unknown) => {
      if (!active || requestIdRef.current !== requestId) return;
      if (!isCurrentSessionGeneration(session) || error instanceof ApiException && error.status === 401) {
        setState({ identity: workspaceId, status: 'session-expired' });
      } else {
        setState({ identity: workspaceId, status: 'unverified' });
      }
    });

    return () => {
      active = false;
      requestIdRef.current++;
      window.removeEventListener(SESSION_EXPIRED_EVENT, expireSession);
    };
  }, [workspaceId, retryNonce]);

  return (
    <section className="g-agent-real-files-panel" aria-labelledby="agent-real-files-heading" data-testid="real-agent-files-panel">
      <header><div><h2 id="agent-real-files-heading">Workspace files</h2><p>Read-only file browsing</p></div><span className="g-agent-file-real-badge">Real API</span></header>
      {status === 'checking' && <p role="status" data-testid="real-files-checking">Checking Agent file capability…</p>}
      {status === 'unsupported' && <p role="status" data-testid="real-files-unsupported">Workspace file browsing is not supported by the current Agent API. No Demo files are shown.</p>}
      {status === 'route-pending' && <p role="status" data-testid="real-files-route-pending">The API advertises sandbox file capability, but this frontend has no reviewed file listing or content route. Browsing remains disabled.</p>}
      {status === 'unverified' && (
        <div role="status" data-testid="real-files-unverified"><p>File capability could not be verified. Browsing remains unavailable.</p>
          <button type="button" onClick={() => setRetryNonce((value) => value + 1)}>Check again</button>
        </div>
      )}
      {status === 'session-expired' && <p role="status" data-testid="real-files-session-expired">Your session has expired. Workspace files are hidden until you sign in again.</p>}
      <p className="g-agent-file-read-only-note">Editing, upload, save, and download are unavailable.</p>
    </section>
  );
};

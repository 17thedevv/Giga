import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApprovalBar } from '../src/features/agent/ApprovalBar.js';
import { MessageBubble } from '../src/features/chat/MessageBubble.js';
import { DiffViewer } from '../src/features/agent/DiffViewer.js';
import { RealApiClient, ApiException } from '../src/lib/api/client.js';
import { SaveCredentialModal } from '../src/features/settings/SaveCredentialModal.js';
import { safeGitHubPullRequestUrl } from '../src/lib/security/untrusted-content.js';
import type { AgentRun, ChangeProposal, Message } from '../src/lib/api/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const completedRun = (prUrl: string): AgentRun => ({
  id: 'run-1',
  status: 'completed',
  task: 'Review changes',
  repository: 'org/repo',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  result: { prUrl, prNumber: 1 },
});

describe('untrusted content and API boundary', () => {
  it('allows only canonical HTTPS GitHub pull request URLs', () => {
    expect(safeGitHubPullRequestUrl('https://github.com/owner/repo/pull/14')).toBe('https://github.com/owner/repo/pull/14');
    for (const url of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'https://github.com.evil.example/owner/repo/pull/14',
      'https://user:pass@github.com/owner/repo/pull/14',
      'https://github.com/owner/repo/pull/14?redirect=https://evil.example',
      'https://github.com/owner%2Fevil/repo/pull/14',
    ]) {
      expect(safeGitHubPullRequestUrl(url)).toBeNull();
    }
  });

  it('does not render or copy an untrusted pull request URL', async () => {
    render(<ApprovalBar run={completedRun('javascript:alert(1)')} onApprove={vi.fn()} onReject={vi.fn()} isApplying={false} mode="real" />);
    expect(screen.getByTestId('invalid-pr-link').textContent).toContain('unsupported');
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy PR URL' })).toBeNull();
  });

  it('renders Markdown-like messages, filenames and diff content as text only', () => {
    const payload = '<script>window.injected=true</script><img src="x" onerror="window.injected=true">';
    const message: Message = { id: 'm1', conversationId: 'c1', role: 'assistant', content: payload, createdAt: '2026-10-01T00:00:00.000Z' };
    const proposal: ChangeProposal = {
      id: 'p1', runId: 'r1', baseCommitSha: '1234567890', createdAt: '2026-10-01T00:00:00.000Z',
      files: [{ path: '../../<img src=x onerror=alert(1)>', status: 'modified', unifiedDiff: payload }],
    };
    const { container } = render(<><MessageBubble message={message} /><DiffViewer proposal={proposal} /></>);
    expect(container.querySelector('script, img, iframe, a')).toBeNull();
    expect(container.textContent).toContain(payload);
    expect(container.textContent).toContain('../../<img src=x onerror=alert(1)>');
  });

  it('redacts a submitted BYOK sentinel from API errors and strips unexpected response fields', async () => {
    const sentinel = 'AIzaSyntheticSentinelKey0123456789';
    const client = new RealApiClient();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: 'CREDENTIAL_REJECTED', message: `Rejected ${sentinel}`, details: { apiKey: sentinel, note: sentinel } },
      }), { status: 400, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        credential: {
          id: 'cred-1', provider: 'gemini', displayHint: '••••6789', status: 'unverified',
          createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', lastValidatedAt: null,
          apiKey: sentinel, internalToken: sentinel,
        },
      }), { status: 201, headers: { 'content-type': 'application/json' } }))
    );

    let caught: unknown;
    try {
      await client.saveProviderCredential({ provider: 'gemini', apiKey: sentinel });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiException);
    expect((caught as Error).message).not.toContain(sentinel);
    expect(JSON.stringify((caught as ApiException).details) ?? '').not.toContain(sentinel);

    const saved = await client.saveProviderCredential({ provider: 'gemini', apiKey: sentinel });
    expect(saved.credential).not.toHaveProperty('apiKey');
    expect(JSON.stringify(saved)).not.toContain(sentinel);
  });

  it('rejects malformed credential DTOs rather than retaining unmasked values', async () => {
    const client = new RealApiClient();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ credential: {
      id: 'cred-1', provider: 'gemini', displayHint: 'plain-secret-value', status: 'valid',
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', lastValidatedAt: null,
    } }), { status: 201, headers: { 'content-type': 'application/json' } })));
    await expect(client.saveProviderCredential({ provider: 'gemini', apiKey: 'SyntheticKeyOnly123456789' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIAL_RESPONSE',
    });
  });

  it('clears the BYOK field after a failed save and keeps the error separate from the secret', async () => {
    const sentinel = 'SyntheticBYOKSentinel0123456789';
    render(<SaveCredentialModal isOpen onClose={vi.fn()} onSave={vi.fn().mockRejectedValue(new Error(`Credential rejected ${sentinel}`))} />);
    const input = screen.getByTestId('gemini-api-key-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: sentinel } });
    fireEvent.click(screen.getByTestId('submit-save-credential-btn'));
    await waitFor(() => expect(input.value).toBe(''));
    expect(document.body.textContent).not.toContain(sentinel);
    expect(localStorage.getItem('giga_api_mode') ?? '').not.toContain(sentinel);
    expect(sessionStorage.getItem('giga_api_mode') ?? '').not.toContain(sentinel);
  });

  it('encodes untrusted resource IDs and preserves same-origin cookie credentials on protected failures', async () => {
    const client = new RealApiClient();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }), {
      status: 404, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client.getConversation('../other-tenant/private')).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/conversations/..%2Fother-tenant%2Fprivate', expect.objectContaining({ credentials: 'include' }));
  });

  it('validates and projects conversation DTOs while redacting common credential forms from content', async () => {
    const client = new RealApiClient();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      conversation: { id: 'c1', title: 'Chat', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', internal: 'private' },
      messages: [{
        id: 'm1', conversationId: 'c1', role: 'assistant',
        content: 'Keep text, redact AIzaSyntheticSentinelCredential0123456789 and DATABASE_URL=postgres://u:p@db.example/giga',
        createdAt: '2026-10-01T00:00:00.000Z', providerReasoning: 'internal-only',
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const result = await client.getConversation('c1');
    expect(result.conversation).not.toHaveProperty('internal');
    expect(result.messages[0]).not.toHaveProperty('providerReasoning');
    expect(result.messages[0].content).toContain('[redacted credential]');
    expect(result.messages[0].content).toContain('[redacted connection URL]');
    expect(result.messages[0].content).not.toContain('postgres://');
  });

  it('projects generation and variant DTOs without worker/provider internals or failed candidate output', async () => {
    const client = new RealApiClient();
    const sentinel = 'AIzaSyntheticGenerationSentinelKey0123456789';
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ generation: {
        id: 'g1', conversationId: 'c1', userMessageId: 'u1', assistantMessageId: 'a1',
        modelId: 'giga-chat-default', status: 'streaming', partialContent: `Partial ${sentinel}`,
        createdAt: '2026-10-01T00:00:00.000Z', providerResponse: { rawReasoning: 'private' },
        workerLeaseToken: 'internal', rawReasoning: 'private',
      } }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        userMessageId: 'u1', selectedGenerationId: 'g1', items: [
          { id: 'g1', action: 'new_prompt', modelId: 'giga-chat-default', status: 'completed', content: 'Completed safe text', createdAt: '2026-10-01T00:00:00.000Z', rawReasoning: 'private' },
          { id: 'g2', action: 'regenerate', modelId: 'giga-chat-default', status: 'failed', content: 'must not be exposed', createdAt: '2026-10-02T00:00:00.000Z', workerLeaseToken: 'internal' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    );

    const generation = (await client.getGeneration('c1', 'g1')).generation;
    expect(generation.partialContent).toContain('[redacted credential]');
    expect(generation).not.toHaveProperty('workerLeaseToken');
    expect(generation).not.toHaveProperty('rawReasoning');
    expect(generation).not.toHaveProperty('providerResponse');

    const variants = await client.getTurnVariants('c1', 'u1');
    expect(variants.items[0].content).toBe('Completed safe text');
    expect(variants.items[1]).not.toHaveProperty('content');
    expect(variants.items[1]).not.toHaveProperty('workerLeaseToken');
    expect(JSON.stringify({ generation, variants })).not.toContain(sentinel);
    expect(JSON.stringify({ generation, variants })).not.toContain('rawReasoning');
  });

  it('rejects malformed generation and variants DTOs instead of trusting API casts', async () => {
    const client = new RealApiClient();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ generation: { id: 'g1', status: 'mystery', rawReasoning: 'private' } }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ userMessageId: 'u1', selectedGenerationId: 'g1', items: [{ id: 'g1', action: 'unknown', status: 'failed' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    );
    await expect(client.getGeneration('c1', 'g1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(client.getTurnVariants('c1', 'u1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

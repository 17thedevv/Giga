import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApprovalBar } from '../src/features/agent/ApprovalBar.js';
import { MessageBubble } from '../src/features/chat/MessageBubble.js';
import { DiffViewer } from '../src/features/agent/DiffViewer.js';
import { RealApiClient, ApiException } from '../src/lib/api/client.js';
import { SaveCredentialModal } from '../src/features/settings/SaveCredentialModal.js';
import { safeGitHubPullRequestUrl } from '../src/lib/security/untrusted-content.js';
import { sanitizeStreamingText } from '../src/lib/security/untrusted-content.js';
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

  it('rejects a protected no-content success that settles after session invalidation', async () => {
    let resolveDelete!: (response: Response) => void;
    const delayedDelete = new Promise<Response>(resolve => { resolveDelete = resolve; });
    const client = new RealApiClient();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/conversations/late-delete')) return delayedDelete;
      return Promise.resolve(new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Session expired' } }), {
        status: 401, headers: { 'content-type': 'application/json' },
      }));
    }));

    const deleteRequest = client.deleteConversation('late-delete');
    await expect(client.getConversation('invalid-session')).rejects.toMatchObject({ status: 401 });
    resolveDelete(new Response(null, { status: 204 }));

    await expect(deleteRequest).rejects.toMatchObject({ status: 401, code: 'SESSION_EXPIRED' });
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

  it('projects auth, conversation, model, Agent, preference and Skills responses to public DTO fields', async () => {
    const client = new RealApiClient();
    const sentinel = 'AIzaSyntheticApiBoundaryCredential0123456789';
    const createdAt = '2026-10-01T00:00:00.000Z';
    const userSkill = {
      id: 'skill-1', ownerId: null, slug: 'safe-skill', title: 'Safe skill', description: 'Description',
      visibility: 'built_in', supportedProducts: ['chat'], revision: 2, createdAt,
    };
    const version = { id: 'version-1', skillId: 'skill-1', versionNumber: 1, contentHash: 'sha256-hash', instructions: `Use safe text ${sentinel}`, createdAt };
    const installation = { id: 'installation-1', userId: 'user-1', skillId: 'skill-1', selectedVersionId: 'version-1', enabled: true, installedAt: createdAt };
    const preferences = { revision: 2, preferredLanguage: 'en', responseLength: 'balanced', responseStyle: 'professional', customInstructions: `Be careful ${sentinel}`, internalPrompt: 'private' };
    const model = { id: 'giga-chat-default', capabilities: ['text', 'streaming', 'unreviewed_internal_capability'], reasoning: { supported: true, efforts: ['low', 'medium'], providerSettings: { apiKey: sentinel } }, providerApiKey: sentinel };
    const run = {
      id: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222',
      task: `Summarize ${sentinel}`, mode: 'execute', runtime: 'cloud', modelId: 'giga-agent-default', status: 'completed',
      createdAt, updatedAt: createdAt, result: { summary: `Complete ${sentinel}`, artifactIds: [], verifiedChecks: [] },
      workerLeaseToken: sentinel, rawReasoning: 'private', providerConfig: { apiKey: sentinel },
      approvalRequest: { id: 'approval-1', apiKey: sentinel },
    };
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ user: { id: 'user-1', email: 'user@example.test', displayName: 'User', apiKey: sentinel, internalRole: 'admin' }, sessionToken: sentinel }))
      .mockResolvedValueOnce(json({ conversation: { id: 'conversation-1', title: 'New chat', createdAt, updatedAt: createdAt, ownerId: 'private' }, workerLeaseToken: sentinel }))
      .mockResolvedValueOnce(json({ items: [{ id: 'conversation-2', title: 'Existing chat', createdAt, updatedAt: createdAt, ownerId: sentinel }], nextCursor: null, rawRows: sentinel }))
      .mockResolvedValueOnce(json({ models: [model], providerCatalog: [{ apiKey: sentinel }] }))
      .mockResolvedValueOnce(json({ run, workerQueue: { leaseToken: sentinel } }))
      .mockResolvedValueOnce(json({ proposal: { id: 'proposal-1', runId: 'run-1', baseCommitSha: 'deadbeef', createdAt, files: [{ path: 'src/file.ts', status: 'modified', unifiedDiff: `+${sentinel}`, additions: 1, deletions: 0, rawWorkerOutput: sentinel }], providerResponse: { reasoning: 'private' } } }))
      .mockResolvedValueOnce(json({ preferences }))
      .mockResolvedValueOnce(json({ preferences: { ...preferences, revision: 3, rawPrompt: sentinel } }))
      .mockResolvedValueOnce(json({ items: [{ ...userSkill, installed: true, enabled: true, selectedVersionId: version.id, databaseUrl: sentinel }], nextCursor: null, workerLeaseToken: sentinel }))
      .mockResolvedValueOnce(json({ skill: { ...userSkill, instructions: sentinel, internalNotes: sentinel } }))
      .mockResolvedValueOnce(json({ skill: { ...userSkill, versions: [version], installation: { ...installation, providerApiKey: sentinel }, rawReasoning: sentinel } }))
      .mockResolvedValueOnce(json({ skill: { ...userSkill, internalNotes: sentinel } }))
      .mockResolvedValueOnce(json({ version: { ...version, apiKey: sentinel } }))
      .mockResolvedValueOnce(json({ installation: { ...installation, workerLeaseToken: sentinel } }))
      .mockResolvedValueOnce(json({ installation: { ...installation, providerConfig: sentinel } }))
      .mockResolvedValueOnce(json({ items: [{ id: 'credential-1', provider: 'gemini', displayHint: '••••6789', status: 'valid', createdAt, updatedAt: createdAt, lastValidatedAt: null, apiKey: sentinel, internalToken: sentinel }] }))
      .mockResolvedValueOnce(json({ mode: 'byok', credentialId: 'credential-1', apiKey: sentinel }))
      .mockResolvedValueOnce(json({ mode: 'platform', credentialId: null, rawProviderKey: sentinel }))
    );

    const me = await client.getMe();
    const conversation = await client.createConversation('New chat');
    const conversations = await client.listConversations();
    const models = await client.listModels();
    const agentRun = await client.getAgentRun(run.id);
    const proposal = await client.getProposal('run-1');
    const prefs = await client.getPreferences();
    const updatedPrefs = await client.updatePreferences({ expectedRevision: 2, responseLength: 'balanced' });
    const skills = await client.listSkills();
    const createdSkill = await client.createSkill({ slug: 'safe-skill', title: 'Safe skill', description: 'Description' });
    const skillDetail = await client.getSkill('skill-1');
    const updatedSkill = await client.updateSkill('skill-1', { title: 'Safe skill', expectedRevision: 2 });
    const publishedVersion = await client.publishSkillVersion('skill-1', { instructions: 'Keep it safe' });
    const installed = await client.installSkill('skill-1');
    const updatedInstallation = await client.updateInstallation('skill-1', { enabled: false });
    const providerCredentials = await client.getProviderCredentials();
    const credentialPreference = await client.getChatCredentialPreference();
    const updatedCredentialPreference = await client.setChatCredentialPreference({ mode: 'platform', credentialId: null });

    expect(me.user).toEqual({ id: 'user-1', email: 'user@example.test', displayName: 'User' });
    expect(conversation.conversation).not.toHaveProperty('ownerId');
    expect(conversations.items[0]).not.toHaveProperty('ownerId');
    expect(conversations.items[0]).not.toHaveProperty('rawRows');
    expect(models.models[0].capabilities).toEqual(['text', 'streaming']);
    expect(models.models[0].reasoning).toEqual({ supported: true, efforts: ['low', 'medium'] });
    expect(agentRun.run).not.toHaveProperty('workerLeaseToken');
    expect(agentRun.run).not.toHaveProperty('providerConfig');
    expect(agentRun.run).not.toHaveProperty('approvalRequest');
    expect(agentRun.run.result?.summary).not.toContain(sentinel);
    expect(proposal.proposal.files[0]).not.toHaveProperty('rawWorkerOutput');
    expect(proposal.proposal.files[0].unifiedDiff).not.toContain(sentinel);
    expect(prefs.preferences).not.toHaveProperty('internalPrompt');
    expect(updatedPrefs.preferences).not.toHaveProperty('rawPrompt');
    expect(skills.items[0]).not.toHaveProperty('databaseUrl');
    expect(createdSkill.skill).not.toHaveProperty('instructions');
    expect(skillDetail.skill.versions?.[0]).not.toHaveProperty('apiKey');
    expect(skillDetail.skill.installation).not.toHaveProperty('providerApiKey');
    expect(updatedSkill.skill).not.toHaveProperty('internalNotes');
    expect(publishedVersion.version).not.toHaveProperty('apiKey');
    expect(installed.installation).not.toHaveProperty('workerLeaseToken');
    expect(updatedInstallation.installation).not.toHaveProperty('providerConfig');
    expect(providerCredentials.items[0]).not.toHaveProperty('apiKey');
    expect(providerCredentials.items[0]).not.toHaveProperty('internalToken');
    expect(credentialPreference).not.toHaveProperty('apiKey');
    expect(updatedCredentialPreference).not.toHaveProperty('rawProviderKey');
    expect(JSON.stringify({ me, conversation, conversations, models, agentRun, proposal, prefs, updatedPrefs, skills, createdSkill, skillDetail, updatedSkill, publishedVersion, installed, updatedInstallation, providerCredentials, credentialPreference, updatedCredentialPreference })).not.toContain(sentinel);
  });

  it('withholds only unresolved credential-shaped stream suffixes, then redacts split credentials at completion', () => {
    const credential = 'AIzaSyntheticSplitStreamCredential0123456789';
    const ordinary = 'This ordinary streamed sentence remains visible before the credential: ';
    let accumulated = '';
    const visibleSnapshots: string[] = [];
    for (const chunk of [ordinary, 'AIzaSyntheticSplit', 'StreamCredential0123456789', ' and ordinary text after it.']) {
      accumulated += chunk;
      visibleSnapshots.push(sanitizeStreamingText(accumulated));
      expect(visibleSnapshots.at(-1)).not.toContain(credential);
      expect(visibleSnapshots.at(-1)).not.toContain('AIzaSynthetic');
    }
    expect(visibleSnapshots.at(-1)).toContain(ordinary);
    const completed = sanitizeStreamingText(accumulated, true);
    expect(completed).toContain(`${ordinary}[redacted credential] and ordinary text after it.`);
    expect(completed).not.toContain(credential);
  });

  it('redacts a sufficiently long credential-shaped stream suffix interrupted before completion', () => {
    const interrupted = sanitizeStreamingText('Answer prefix AIzaSyntheticPartialKey', true);
    expect(interrupted).toBe('Answer prefix [redacted credential fragment]');
  });

  it('redacts long credential assignments immediately without buffering their value', () => {
    const streamed = sanitizeStreamingText(`Answer prefix api_key=${'a'.repeat(10_000)}`);
    expect(streamed).toBe('Answer prefix api_key=[redacted]');
    expect(streamed.length).toBeLessThan(64);
  });

  it('projects every Agent run response path to the workspace-run contract', async () => {
    const client = new RealApiClient();
    const createdAt = '2026-10-01T00:00:00.000Z';
    const run = {
      id: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222',
      task: 'A task', mode: 'execute', runtime: 'cloud', modelId: 'giga-agent-default', status: 'running',
      createdAt, updatedAt: createdAt, workerLeaseToken: 'synthetic-worker-token', rawReasoning: 'private',
    };
    const json = () => new Response(JSON.stringify({ run }), { status: 200, headers: { 'content-type': 'application/json' } });
    const fetchMock = vi.fn().mockResolvedValueOnce(json()).mockResolvedValueOnce(json()).mockResolvedValueOnce(json()).mockResolvedValueOnce(json());
    vi.stubGlobal('fetch', fetchMock);

    const created = await client.createAgentRun(
      { workspaceId: run.workspaceId, task: 'A task', mode: 'execute' },
      { idempotencyKey: 'agent-test-key' }
    );
    const fetched = await client.getAgentRun(run.id);
    const decided = await client.submitDecision(run.id, 'proposal-id', 'reject');
    const cancelled = await client.cancelAgentRun(run.id);
    for (const response of [created, fetched, decided, cancelled]) {
      expect(response.run).not.toHaveProperty('workerLeaseToken');
      expect(response.run).not.toHaveProperty('rawReasoning');
      expect(Object.keys(response.run)).toEqual(expect.arrayContaining(['id', 'workspaceId', 'task', 'mode', 'runtime', 'modelId', 'status', 'createdAt', 'updatedAt']));
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Idempotency-Key')).toBe('agent-test-key');
  });

  it('rejects malformed auth, chat, model, preference, Skills and Agent response shapes', async () => {
    const client = new RealApiClient();
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ user: { id: 'user-1', apiKey: 'synthetic' } }))
      .mockResolvedValueOnce(json({ conversation: { id: 'c1', title: 'Bad dates', createdAt: 'yesterday', updatedAt: 'later' } }))
      .mockResolvedValueOnce(json({ models: [{ providerApiKey: 'synthetic' }] }))
      .mockResolvedValueOnce(json({ preferences: { revision: -1, responseLength: 'unknown', responseStyle: 'technical', customInstructions: '' } }))
      .mockResolvedValueOnce(json({ items: [{ id: 'skill-1', ownerId: null, slug: 'x', title: 'x', description: '', visibility: 'private', supportedProducts: ['chat'], createdAt: '2026-10-01T00:00:00.000Z', installed: false, enabled: false, selectedVersionId: null }] }))
      .mockResolvedValueOnce(json({ run: { id: 'invalid', workerLeaseToken: 'synthetic' } }))
    );

    await expect(client.getMe()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(client.createConversation()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(client.listModels()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(client.getPreferences()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(client.listSkills()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(client.getAgentRun('run-id')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

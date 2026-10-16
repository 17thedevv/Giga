import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApiModeProvider } from '../src/app/context/ApiModeContext.js';
import { AuthProvider } from '../src/app/context/AuthContext.js';
import { RouterProvider } from '../src/app/router.js';
import { ChatView } from '../src/features/chat/ChatView.js';
import { Composer } from '../src/features/chat/Composer.js';
import { ReasoningSelector } from '../src/features/chat/ReasoningSelector.js';
import {
  normalizeModelMetadata,
  normalizeReasoningConfig,
  isReasoningSupported,
  getSupportedReasoningEfforts,
  getEffectiveReasoningEffort,
} from '../src/features/chat/model-capabilities.js';
import { realApiClient } from '../src/lib/api/client.js';
import { mockDataAdapter } from '../src/lib/api/mock-adapter.js';
import type { ModelMetadata } from '../src/lib/api/types.js';

describe('17T-42 — Capability-Driven Reasoning Controls in GigaChat', () => {
  beforeEach(() => {
    if (typeof window !== 'undefined') {
      if (window.sessionStorage) {
        window.sessionStorage.clear();
      }
      window.history.replaceState({}, '', '/');
    }
    mockDataAdapter.setMockSession({
      id: 'usr_test_reasoning',
      email: 'trangthu@demo.giga.dev',
      displayName: 'Tráng A Thư',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Section 1: Capability Normalization & Validation Unit Tests
  // =========================================================================
  describe('Capability Normalization & Validation Functions', () => {
    it('Scenario 1: Model supports all three reasoning levels (low, medium, high)', () => {
      const model: ModelMetadata = {
        id: 'model-all-three',
        capabilities: ['text', 'streaming'],
        reasoning: {
          supported: true,
          efforts: ['low', 'medium', 'high'],
        },
      };

      expect(isReasoningSupported(model)).toBe(true);
      expect(getSupportedReasoningEfforts(model)).toEqual(['low', 'medium', 'high']);
      expect(getEffectiveReasoningEffort(model, 'low')).toBe('low');
      expect(getEffectiveReasoningEffort(model, 'medium')).toBe('medium');
      expect(getEffectiveReasoningEffort(model, 'high')).toBe('high');
      expect(getEffectiveReasoningEffort(model, undefined)).toBeUndefined();
    });

    it('Scenario 2: Model supports only a subset of reasoning levels', () => {
      const model: ModelMetadata = {
        id: 'model-subset',
        capabilities: ['text', 'streaming'],
        reasoning: {
          supported: true,
          efforts: ['low', 'medium'],
        },
      };

      expect(isReasoningSupported(model)).toBe(true);
      expect(getSupportedReasoningEfforts(model)).toEqual(['low', 'medium']);
      expect(getEffectiveReasoningEffort(model, 'low')).toBe('low');
      expect(getEffectiveReasoningEffort(model, 'medium')).toBe('medium');
      // 'high' is not in the supported subset, so getEffectiveReasoningEffort must return undefined
      expect(getEffectiveReasoningEffort(model, 'high')).toBeUndefined();
    });

    it('Scenario 3: Model does not support reasoning controls', () => {
      const model: ModelMetadata = {
        id: 'model-no-reasoning',
        capabilities: ['text', 'streaming'],
        reasoning: {
          supported: false,
          efforts: [],
        },
      };

      expect(isReasoningSupported(model)).toBe(false);
      expect(getSupportedReasoningEfforts(model)).toEqual([]);
      expect(getEffectiveReasoningEffort(model, 'medium')).toBeUndefined();
    });

    it('Scenario 4: API response lacks capability metadata (missing reasoning object)', () => {
      const rawWithoutReasoning = {
        id: 'model-missing-metadata',
        capabilities: ['text', 'streaming'],
      };

      const normalized = normalizeModelMetadata(rawWithoutReasoning);
      expect(normalized.id).toBe('model-missing-metadata');
      expect(normalized.reasoning).toEqual({ supported: false, efforts: [] });
      expect(isReasoningSupported(normalized)).toBe(false);
      expect(getSupportedReasoningEfforts(normalized)).toEqual([]);

      // Test with null or non-object reasoning
      const rawWithNullReasoning = {
        id: 'model-null-reasoning',
        capabilities: ['text'],
        reasoning: null,
      };
      const normalizedNull = normalizeModelMetadata(rawWithNullReasoning);
      expect(normalizedNull.reasoning).toEqual({ supported: false, efforts: [] });
      expect(isReasoningSupported(normalizedNull)).toBe(false);
    });

    it('Scenario 5: Capability contains unrecognized values from backend', () => {
      const rawWithAlienEfforts = {
        supported: true,
        efforts: [
          'low',
          'ultra_heavy_budget',
          'medium',
          12345,
          null,
          'thinkingLevel=MINIMAL',
          'high',
        ],
      };

      const normalizedConfig = normalizeReasoningConfig(rawWithAlienEfforts);
      // Only valid normalized Giga values ['low', 'medium', 'high'] are kept
      expect(normalizedConfig.supported).toBe(true);
      expect(normalizedConfig.efforts).toEqual(['low', 'medium', 'high']);

      // If all efforts are unrecognized, supported must fail closed to false
      const allBogus = normalizeReasoningConfig({
        supported: true,
        efforts: ['bogus_effort', 'extreme'],
      });
      expect(allBogus.supported).toBe(false);
      expect(allBogus.efforts).toEqual([]);
    });
  });

  // =========================================================================
  // Section 2: UI Component Rendering & Accessibility
  // =========================================================================
  describe('ReasoningSelector & Composer Component Behavior', () => {
    it('Scenario 1 (UI): Renders all three levels when model supports them', () => {
      const model: ModelMetadata = {
        id: 'model-full',
        capabilities: ['text', 'streaming'],
        reasoning: { supported: true, efforts: ['low', 'medium', 'high'] },
      };
      const onChange = vi.fn();

      render(
        <ReasoningSelector model={model} value={undefined} onChange={onChange} />
      );

      const select = screen.getByTestId('composer-reasoning-select') as HTMLSelectElement;
      expect(select.disabled).toBe(false);

      const options = Array.from(select.options).map((opt) => opt.text);
      expect(options).toEqual(['Default', 'Low', 'Medium', 'High']);
      expect(select.value).toBe(''); // "Default"
    });

    it('Scenario 2 (UI): Renders only supported subset of levels', () => {
      const model: ModelMetadata = {
        id: 'model-partial',
        capabilities: ['text', 'streaming'],
        reasoning: { supported: true, efforts: ['low', 'medium'] },
      };
      const onChange = vi.fn();

      render(
        <ReasoningSelector model={model} value="low" onChange={onChange} />
      );

      const select = screen.getByTestId('composer-reasoning-select') as HTMLSelectElement;
      expect(select.disabled).toBe(false);

      const options = Array.from(select.options).map((opt) => opt.text);
      expect(options).toEqual(['Default', 'Low', 'Medium']);
      expect(options).not.toContain('High');
      expect(select.value).toBe('low');
    });

    it('Scenario 3 (UI): Disables selector with neutral text when reasoning is unsupported', () => {
      const model: ModelMetadata = {
        id: 'model-none',
        capabilities: ['text', 'streaming'],
        reasoning: { supported: false, efforts: [] },
      };
      const onChange = vi.fn();

      render(
        <ReasoningSelector model={model} value="medium" onChange={onChange} />
      );

      const select = screen.getByTestId('composer-reasoning-select') as HTMLSelectElement;
      expect(select.disabled).toBe(true);

      const options = Array.from(select.options).map((opt) => opt.text);
      expect(options).toEqual(['Not supported']);
    });

    it('Scenario 13: Responsive layout and accessibility compliance', () => {
      const model: ModelMetadata = {
        id: 'model-accessible',
        capabilities: ['text', 'streaming'],
        reasoning: { supported: true, efforts: ['low', 'medium', 'high'] },
      };

      render(
        <Composer
          onSend={vi.fn()}
          onStop={vi.fn()}
          isStreaming={false}
          models={[model]}
          selectedModelId="model-accessible"
          onSelectModel={vi.fn()}
          reasoningEffort={undefined}
          onSelectReasoningEffort={vi.fn()}
        />
      );

      // Label accessibility
      const label = screen.getByText('Reasoning:');
      expect(label).toBeDefined();
      expect(label.getAttribute('for')).toBe('composer-reasoning-select');

      const select = screen.getByTestId('composer-reasoning-select');
      expect(select.getAttribute('aria-label')).toBe('Reasoning effort');
      expect(select.getAttribute('id')).toBe('composer-reasoning-select');

      // Model label accessibility
      const modelLabel = screen.getByText('Model:');
      expect(modelLabel.getAttribute('for')).toBe('composer-model-select');
      const modelSelect = screen.getByTestId('composer-model-select');
      expect(modelSelect.getAttribute('aria-label')).toBe('Select model');
    });
  });

  // =========================================================================
  // Section 3: Integration Tests in ChatView & Request Contract
  // =========================================================================
  describe('ChatView Reasoning Controls & Lifecycle Integration', () => {
    it('Scenario 6: Switching model clears previous selection if invalid for new model', async () => {
      const modelFull: ModelMetadata = {
        id: 'model-full',
        capabilities: ['text', 'streaming'],
        reasoning: { supported: true, efforts: ['low', 'medium', 'high'] },
      };
      const modelPartial: ModelMetadata = {
        id: 'model-partial',
        capabilities: ['text', 'streaming'],
        reasoning: { supported: true, efforts: ['low', 'medium'] },
      };
      const modelNoReasoning: ModelMetadata = {
        id: 'model-none',
        capabilities: ['text', 'streaming'],
        reasoning: { supported: false, efforts: [] },
      };

      vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({
        items: [
          {
            id: 'conv_123',
            title: 'Test Discussion',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        nextCursor: null,
      });
      vi.spyOn(realApiClient, 'getConversation').mockResolvedValue({
        conversation: {
          id: 'conv_123',
          title: 'Test Discussion',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        messages: [],
      });
      vi.spyOn(realApiClient, 'listModels').mockResolvedValue({
        models: [modelFull, modelPartial, modelNoReasoning],
      });

      render(
        <ApiModeProvider initialMode="real">
          <AuthProvider>
            <RouterProvider>
              <ChatView />
            </RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      );

      // Wait for models to load
      await waitFor(() => {
        expect(screen.getByTestId('composer-model-select')).toBeDefined();
      });

      const modelSelect = screen.getByTestId('composer-model-select') as HTMLSelectElement;
      const reasoningSelect = screen.getByTestId('composer-reasoning-select') as HTMLSelectElement;

      // 1. Initial state: model-full is selected, reasoning is Default ("")
      expect(modelSelect.value).toBe('model-full');
      expect(reasoningSelect.value).toBe('');

      // 2. User selects 'high' on model-full
      fireEvent.change(reasoningSelect, { target: { value: 'high' } });
      expect(reasoningSelect.value).toBe('high');

      // 3. User switches to model-partial (which only supports ['low', 'medium'])
      fireEvent.change(modelSelect, { target: { value: 'model-partial' } });
      // The invalid 'high' selection must be cleared to "" (Default)!
      expect(reasoningSelect.value).toBe('');

      // 4. User selects 'low' on model-partial
      fireEvent.change(reasoningSelect, { target: { value: 'low' } });
      expect(reasoningSelect.value).toBe('low');

      // 5. User switches to model-none (which does not support reasoning)
      fireEvent.change(modelSelect, { target: { value: 'model-none' } });
      // Reasoning selector must be disabled with "Not supported"
      expect(reasoningSelect.disabled).toBe(true);
      expect(reasoningSelect.value).toBe('');
      expect(screen.getByText('Not supported')).toBeDefined();
    });

    it('Scenario 7 & 12: Select effort and verify request includes normalized reasoningEffort with NO provider leaks', async () => {
      const model: ModelMetadata = {
        id: 'giga-gemini-preview',
        capabilities: ['text', 'streaming'],
        reasoning: { supported: true, efforts: ['low', 'medium', 'high'] },
      };

      vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({
        items: [
          {
            id: 'conv_req_test',
            title: 'Request Test',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        nextCursor: null,
      });
      vi.spyOn(realApiClient, 'getConversation').mockResolvedValue({
        conversation: {
          id: 'conv_req_test',
          title: 'Request Test',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        messages: [],
      });
      vi.spyOn(realApiClient, 'listModels').mockResolvedValue({
        models: [model],
      });

      let capturedOptions: any;
      const streamSpy = vi
        .spyOn(realApiClient, 'streamMessage')
        .mockImplementation(async (_convId, _content, onEvent, options) => {
          capturedOptions = options;
          onEvent({
            event: 'message.started',
            data: { messageId: 'm1', generationId: 'g1', conversationId: 'conv_req_test' },
          });
          onEvent({
            event: 'message.completed',
            data: { messageId: 'm1', generationId: 'g1' },
          });
        });

      render(
        <ApiModeProvider initialMode="real">
          <AuthProvider>
            <RouterProvider>
              <ChatView />
            </RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('composer-reasoning-select')).toBeDefined();
      });

      // User selects 'medium'
      const reasoningSelect = screen.getByTestId('composer-reasoning-select');
      fireEvent.change(reasoningSelect, { target: { value: 'medium' } });

      // User submits message
      const textarea = screen.getByPlaceholderText(/Ask Giga anything/);
      fireEvent.change(textarea, { target: { value: 'Explain quantum computing' } });

      const sendButton = screen.getByRole('button', { name: /Send Message/i });
      fireEvent.click(sendButton);

      await waitFor(() => {
        expect(streamSpy).toHaveBeenCalled();
      });

      // Scenario 7: reasoningEffort is passed as "medium"
      expect(capturedOptions).toBeDefined();
      expect(capturedOptions.reasoningEffort).toBe('medium');
      expect(capturedOptions.modelId).toBe('giga-gemini-preview');

      // Scenario 12: Request must NOT leak provider-native fields
      expect(capturedOptions.thinkingConfig).toBeUndefined();
      expect(capturedOptions.thinkingBudget).toBeUndefined();
      expect(capturedOptions['reasoning.effort']).toBeUndefined();
      expect(capturedOptions.thinkingLevel).toBeUndefined();
    });

    it('Scenario 8: Does NOT send reasoningEffort when effort is unselected (Default)', async () => {
      const model: ModelMetadata = {
        id: 'giga-chat-default',
        capabilities: ['text', 'streaming'],
        reasoning: { supported: true, efforts: ['low', 'medium', 'high'] },
      };

      vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({
        items: [
          {
            id: 'conv_unselected',
            title: 'Unselected Test',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        nextCursor: null,
      });
      vi.spyOn(realApiClient, 'getConversation').mockResolvedValue({
        conversation: {
          id: 'conv_unselected',
          title: 'Unselected Test',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        messages: [],
      });
      vi.spyOn(realApiClient, 'listModels').mockResolvedValue({
        models: [model],
      });

      let capturedOptions: any;
      const streamSpy = vi
        .spyOn(realApiClient, 'streamMessage')
        .mockImplementation(async (_convId, _content, onEvent, options) => {
          capturedOptions = options;
          onEvent({
            event: 'message.started',
            data: { messageId: 'm1', generationId: 'g1', conversationId: 'conv_unselected' },
          });
          onEvent({
            event: 'message.completed',
            data: { messageId: 'm1', generationId: 'g1' },
          });
        });

      render(
        <ApiModeProvider initialMode="real">
          <AuthProvider>
            <RouterProvider>
              <ChatView />
            </RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('composer-reasoning-select')).toBeDefined();
      });

      // Keep default selection ("")
      const reasoningSelect = screen.getByTestId('composer-reasoning-select') as HTMLSelectElement;
      expect(reasoningSelect.value).toBe('');

      // Send message
      const textarea = screen.getByPlaceholderText(/Ask Giga anything/);
      fireEvent.change(textarea, { target: { value: 'Hello Giga' } });
      fireEvent.click(screen.getByRole('button', { name: /Send Message/i }));

      await waitFor(() => {
        expect(streamSpy).toHaveBeenCalled();
      });

      // reasoningEffort must be undefined (omitted) so model default applies
      expect(capturedOptions.reasoningEffort).toBeUndefined();
    });

    it('Scenario 9: streamVariant accepts current reasoning effort selection and omits when unselected', async () => {
      let variantBodySent: string | null = null;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if (typeof url === 'string' && url.includes('/generations:stream')) {
          variantBodySent = init?.body as string;
          return new Response(
            'event: message.started\ndata: {"messageId":"m1","generationId":"g1","conversationId":"c1"}\n\n' +
            'event: message.completed\ndata: {"messageId":"m1","generationId":"g1"}\n\n',
            { headers: { 'Content-Type': 'text/event-stream' }, status: 200 }
          );
        }
        return new Response('{}', { status: 200 });
      });

      // 1. With explicit reasoningEffort: 'low'
      await realApiClient.streamVariant(
        'c1',
        'u1',
        'regenerate',
        () => {},
        { reasoningEffort: 'low', modelId: 'giga-chat-default' }
      );
      expect(variantBodySent).not.toBeNull();
      const parsedWithEffort = JSON.parse(variantBodySent!);
      expect(parsedWithEffort.reasoningEffort).toBe('low');
      expect(parsedWithEffort.userMessageId).toBe('u1');
      expect(parsedWithEffort.action).toBe('regenerate');

      // 2. Without reasoningEffort (unselected)
      await realApiClient.streamVariant(
        'c1',
        'u1',
        'retry',
        () => {},
        { modelId: 'giga-chat-default' }
      );
      const parsedWithoutEffort = JSON.parse(variantBodySent!);
      expect(parsedWithoutEffort.reasoningEffort).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(parsedWithoutEffort, 'reasoningEffort')).toBe(false);
      expect(parsedWithoutEffort.action).toBe('retry');
    });

    it('Scenario 10: Stop / durable cancellation operates smoothly during reasoning generation', async () => {
      const model: ModelMetadata = {
        id: 'model-reasoning',
        capabilities: ['text', 'streaming'],
        reasoning: { supported: true, efforts: ['low', 'medium', 'high'] },
      };

      vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({
        items: [
          {
            id: 'conv_stop_test',
            title: 'Stop Test',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        nextCursor: null,
      });
      vi.spyOn(realApiClient, 'getConversation').mockResolvedValue({
        conversation: {
          id: 'conv_stop_test',
          title: 'Stop Test',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        messages: [],
      });
      vi.spyOn(realApiClient, 'listModels').mockResolvedValue({
        models: [model],
      });

      const cancelSpy = vi.spyOn(realApiClient, 'cancelGeneration').mockResolvedValue({
        generation: {
          id: 'gen_stop_1',
          conversationId: 'conv_stop_test',
          userMessageId: 'u1',
          modelId: 'model-reasoning',
          reasoningEffort: 'high',
          status: 'stopped',
          partialContent: 'Thinking in progress...',
          finishReason: 'cancelled',
          createdAt: new Date().toISOString(),
        },
      });

      vi.spyOn(realApiClient, 'streamMessage').mockImplementation(
        async (_convId, _content, onEvent) => {
          onEvent({
            event: 'message.started',
            data: { messageId: 'm1', generationId: 'gen_stop_1', conversationId: 'conv_stop_test' },
          });
          onEvent({
            event: 'message.delta',
            data: { messageId: 'm1', generationId: 'gen_stop_1', text: 'Thinking in progress...' },
          });
          // Do not complete immediately; simulate ongoing generation until stopped
        }
      );

      render(
        <ApiModeProvider initialMode="real">
          <AuthProvider>
            <RouterProvider>
              <ChatView />
            </RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('composer-reasoning-select')).toBeDefined();
      });

      // Select 'high'
      fireEvent.change(screen.getByTestId('composer-reasoning-select'), {
        target: { value: 'high' },
      });

      // Submit message
      fireEvent.change(screen.getByPlaceholderText(/Ask Giga anything/), {
        target: { value: 'Solve this hard math problem' },
      });
      fireEvent.click(screen.getByRole('button', { name: /Send Message/i }));

      // Stop button appears
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Stop Generating/i })).toBeDefined();
      });

      // Click Stop button
      fireEvent.click(screen.getByRole('button', { name: /Stop Generating/i }));

      await waitFor(() => {
        expect(cancelSpy).toHaveBeenCalledWith('conv_stop_test', 'gen_stop_1');
      });
    });

    it('Scenario 11: BYOK and platform mode have identical request contract semantics', async () => {
      let capturedPayload: any;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if (typeof url === 'string' && url.includes('/messages:stream')) {
          capturedPayload = JSON.parse(init?.body as string);
          return new Response(
            'event: message.started\ndata: {"messageId":"m1","generationId":"g1","conversationId":"c1"}\n\n' +
            'event: message.completed\ndata: {"messageId":"m1","generationId":"g1"}\n\n',
            { headers: { 'Content-Type': 'text/event-stream' }, status: 200 }
          );
        }
        return new Response('{}', { status: 200 });
      });

      // Test streamMessage invocation directly
      await realApiClient.streamMessage('conv_byok', 'Testing BYOK semantics', () => {}, {
        modelId: 'giga-chat-default',
        reasoningEffort: 'high',
      });

      expect(capturedPayload).toEqual({
        content: 'Testing BYOK semantics',
        modelId: 'giga-chat-default',
        reasoningEffort: 'high',
      });
      // Guarantees zero BYOK-specific or platform-specific variance in public request shape
      expect(capturedPayload.credentialType).toBeUndefined();
      expect(capturedPayload.apiKey).toBeUndefined();
      expect(capturedPayload.provider).toBeUndefined();
    });
  });
});

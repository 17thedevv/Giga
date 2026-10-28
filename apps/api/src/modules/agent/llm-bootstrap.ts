import { GeminiKeyPool } from '../llm/gemini-key-pool.js';
import { LLMEngine } from '../llm/engine.js';
import { ProviderCredential } from '../llm/provider-credential.js';
import { ModelRegistry } from '../llm/registry.js';
import { CHAT_MODEL_ID, GeminiProvider, type ProviderTransport } from '../llm/providers/gemini/gemini-provider.js';
import type { ChatProviderConfig } from '../llm/chat-bootstrap.js';
import { validateChatConfig } from '../llm/chat-bootstrap.js';
import { AGENT_MODEL_ALIAS } from './types.js';
import type { ToolRegistry } from './tool-registry.js';
import { LLMBackedAgentDecisionProvider } from './llm-decision-provider.js';
import type { AgentLLMDecisionProviderOptions } from './llm-decision-provider.js';

/**
 * Builds an Agent-only allowlisted LLM Engine using the existing platform
 * Gemini configuration. User BYOK resolution is intentionally not accepted.
 */
export function createAgentLLMDecisionProvider(
  platformConfig: ChatProviderConfig | undefined,
  toolRegistry: ToolRegistry,
  transport?: ProviderTransport,
  options: AgentLLMDecisionProviderOptions = {},
): LLMBackedAgentDecisionProvider {
  if (!platformConfig) return new LLMBackedAgentDecisionProvider(undefined, toolRegistry, options);
  validateChatConfig(platformConfig);

  const registry = new ModelRegistry();
  registry.registerAdapter(new GeminiProvider(
    transport,
    85_000,
    platformConfig.apiKeys ? new GeminiKeyPool(platformConfig.apiKeys) : undefined,
  ));
  registry.registerAlias({
    alias: AGENT_MODEL_ALIAS,
    providerId: 'gemini',
    modelId: CHAT_MODEL_ID,
    requiredCapabilities: ['text'],
    maxOutputTokensLimit: Math.min(platformConfig.maxOutputTokens, 1024),
    reasoning: { supported: true, efforts: ['low', 'medium', 'high'] },
  });
  registry.validate();
  const engine = new LLMEngine(registry, new ProviderCredential(platformConfig.apiKey, 'platform'));
  const maxOutputTokens = Math.min(options.maxOutputTokens ?? 1024, platformConfig.maxOutputTokens, 1024);
  return new LLMBackedAgentDecisionProvider(engine, toolRegistry, { ...options, maxOutputTokens });
}

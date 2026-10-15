import { CHAT_MODEL_ALIAS } from '../chat/chat-runtime.js';
import { LLMEngine } from './engine.js';
import { ModelRegistry } from './registry.js';
import { CHAT_MODEL_ID, GeminiProvider, type ProviderTransport } from './providers/gemini/gemini-provider.js';

export interface ChatProviderConfig {
  readonly apiKey: string;
  readonly modelId: string;
  readonly maxOutputTokens: number;
}
export function validateChatConfig(config: ChatProviderConfig): void {
  if (!/^[\x21-\x7e]{16,512}$/.test(config.apiKey)) throw new Error('Invalid or missing GEMINI_API_KEY configuration');
  if (config.modelId !== CHAT_MODEL_ID) throw new Error('CHAT_MODEL_ID must name the reviewed Gemini chat model');
  if (!Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens < 1 || config.maxOutputTokens > 2048) throw new Error('CHAT_MAX_OUTPUT_TOKENS must be an integer from 1 to 2048');
}
export function loadChatConfig(env: NodeJS.ProcessEnv, production: boolean): ChatProviderConfig | undefined {
  if (env.CHAT_ENABLED !== undefined && env.CHAT_ENABLED !== 'true' && env.CHAT_ENABLED !== 'false') throw new Error('CHAT_ENABLED must be true or false');
  if (env.CHAT_ENABLED === 'false') return undefined;
  const configured = ['GEMINI_API_KEY', 'CHAT_MODEL_ID', 'CHAT_MAX_OUTPUT_TOKENS'].some((key) => env[key] !== undefined);
  if (env.CHAT_ENABLED !== 'true' && !production && !configured) return undefined;
  if (env.GEMINI_BASE_URL !== undefined || env.CHAT_PROVIDER_URL !== undefined || env.CHAT_PROVIDER !== undefined) throw new Error('Custom chat providers and endpoints are not supported');
  const rawLimit = env.CHAT_MAX_OUTPUT_TOKENS ?? '1024';
  if (!/^\d+$/.test(rawLimit)) throw new Error('CHAT_MAX_OUTPUT_TOKENS must be an integer from 1 to 2048');
  const config = { apiKey: env.GEMINI_API_KEY ?? '', modelId: env.CHAT_MODEL_ID?.trim() ?? '', maxOutputTokens: Number(rawLimit) };
  validateChatConfig(config);
  return config;
}
export function createChatEngine(config: ChatProviderConfig | undefined, transport?: ProviderTransport): LLMEngine | undefined {
  if (!config) return undefined;
  validateChatConfig(config);
  const registry = new ModelRegistry();
  registry.registerAdapter(new GeminiProvider(config.apiKey, transport));
  registry.registerAlias({ alias: CHAT_MODEL_ALIAS, providerId: 'gemini', modelId: config.modelId,
    requiredCapabilities: ['text', 'streaming'], maxOutputTokensLimit: config.maxOutputTokens });
  registry.validate();
  registry.resolve(CHAT_MODEL_ALIAS, 'streaming');
  return new LLMEngine(registry);
}

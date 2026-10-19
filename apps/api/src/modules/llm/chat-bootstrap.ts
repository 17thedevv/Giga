import { CHAT_MODEL_ALIAS } from '../chat/chat-runtime.js';
import { GeminiKeyPool } from './gemini-key-pool.js';
import { LLMEngine } from './engine.js';
import { ProviderCredential } from './provider-credential.js';
import { ModelRegistry } from './registry.js';
import { CHAT_MODEL_ID, GeminiProvider, type ProviderTransport } from './providers/gemini/gemini-provider.js';

export interface ChatProviderConfig {
  readonly apiKey: string;
  readonly apiKeys?: readonly string[];
  readonly modelId: string;
  readonly maxOutputTokens: number;
}
export function validateChatConfig(config: ChatProviderConfig): void {
  if (!/^[\x21-\x7e]{16,512}$/.test(config.apiKey)) throw new Error('Invalid or missing GEMINI_API_KEY configuration');
  if (config.apiKeys && (!config.apiKeys.length || config.apiKeys.length > 8 || config.apiKeys.some(key => typeof key !== 'string' || !/^[\x21-\x7e]{16,512}$/.test(key)))) throw new Error('Invalid GEMINI_API_KEYS configuration');
  if (config.modelId !== CHAT_MODEL_ID) throw new Error('CHAT_MODEL_ID must name the reviewed Gemini chat model');
  if (!Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens < 1 || config.maxOutputTokens > 2048) throw new Error('CHAT_MAX_OUTPUT_TOKENS must be an integer from 1 to 2048');
}
export function loadChatConfig(env: NodeJS.ProcessEnv, production: boolean): ChatProviderConfig | undefined {
  if (env.CHAT_ENABLED !== undefined && env.CHAT_ENABLED !== 'true' && env.CHAT_ENABLED !== 'false') throw new Error('CHAT_ENABLED must be true or false');
  if (env.CHAT_ENABLED === 'false') return undefined;
  const configured = ['GEMINI_API_KEY', 'GEMINI_API_KEYS', 'CHAT_MODEL_ID', 'CHAT_MAX_OUTPUT_TOKENS'].some((key) => env[key] !== undefined);
  if (env.CHAT_ENABLED !== 'true' && !production && !configured) return undefined;
  if (env.GEMINI_BASE_URL !== undefined || env.CHAT_PROVIDER_URL !== undefined || env.CHAT_PROVIDER !== undefined) throw new Error('Custom chat providers and endpoints are not supported');
  const rawLimit = env.CHAT_MAX_OUTPUT_TOKENS ?? '1024';
  if (!/^\d+$/.test(rawLimit)) throw new Error('CHAT_MAX_OUTPUT_TOKENS must be an integer from 1 to 2048');
  let apiKeys: readonly string[] | undefined;
  if (env.GEMINI_API_KEYS !== undefined) {
    try {
      if (env.GEMINI_API_KEYS.length > 5000) throw new Error();
      const parsed: unknown = JSON.parse(env.GEMINI_API_KEYS);
      if (!Array.isArray(parsed) || !parsed.length || parsed.length > 8 || parsed.some(key => typeof key !== 'string' || !/^[\x21-\x7e]{16,512}$/.test(key))) throw new Error();
      apiKeys = [...new Set(parsed as string[])];
    } catch { throw new Error('GEMINI_API_KEYS must be a JSON array of 1 to 8 valid keys'); }
  }
  const config = { apiKey: apiKeys?.[0] ?? env.GEMINI_API_KEY ?? '', ...(apiKeys ? { apiKeys } : {}), modelId: env.CHAT_MODEL_ID?.trim() ?? '', maxOutputTokens: Number(rawLimit) };
  validateChatConfig(config);
  return config;
}
export function createChatEngine(config: ChatProviderConfig | undefined, transport?: ProviderTransport): LLMEngine | undefined {
  if (!config) return undefined;
  validateChatConfig(config);
  const registry = new ModelRegistry();
  registry.registerAdapter(new GeminiProvider(transport, 85000, config.apiKeys ? new GeminiKeyPool(config.apiKeys) : undefined));
  registry.registerAlias({ alias: CHAT_MODEL_ALIAS, providerId: 'gemini', modelId: config.modelId,
    requiredCapabilities: ['text', 'streaming'], maxOutputTokensLimit: config.maxOutputTokens,
    reasoning: { supported: true, efforts: ['low', 'medium', 'high'] } });
  registry.validate();
  registry.resolve(CHAT_MODEL_ALIAS, 'streaming');
  return new LLMEngine(registry, new ProviderCredential(config.apiKey, 'platform'));
}

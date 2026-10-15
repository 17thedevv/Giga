/**
 * Shared LLM Engine v0.1 — Model Registry
 *
 * Manages model aliases and provider adapters.
 * Ensures model resolution, capability validation, and fail-fast startup checks.
 * In production, missing provider configurations fail closed and never fall back to fake adapters.
 */

import type { ProviderAdapter } from './adapter.js';
import {
  LLMValidationError,
  ProviderUnavailableError,
  UnknownModelAliasError,
  UnsupportedCapabilityError,
} from './errors.js';
import {
  VALID_REASONING_EFFORTS,
  type Capability,
  type ModelAliasConfig,
  type ModelMetadata,
  type ModelReasoningConfig,
  type ReasoningEffort,
} from './types.js';

const VALID_CAPABILITIES: ReadonlySet<Capability> = new Set([
  'text',
  'streaming',
  'structured',
  'embeddings',
  'tool_calling',
]);

const VALID_EFFORTS: ReadonlySet<ReasoningEffort> = new Set(VALID_REASONING_EFFORTS);

const VALID_ALIAS_REGEX = /^[a-zA-Z0-9_-]+$/;

export class ModelRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly aliases = new Map<string, ModelAliasConfig>();

  /**
   * Registers a provider adapter.
   */
  public registerAdapter(adapter: ProviderAdapter): void {
    if (!adapter || typeof adapter !== 'object') {
      throw new LLMValidationError('Adapter must be an object');
    }
    if (!adapter.providerId || typeof adapter.providerId !== 'string' || adapter.providerId.trim() === '') {
      throw new LLMValidationError('Adapter providerId must be a non-empty string');
    }
    if (!(adapter.capabilities instanceof Set) && !(adapter.capabilities instanceof (Map as unknown as typeof Set))) {
      // Check if it has .has() method
      if (!adapter.capabilities || typeof adapter.capabilities.has !== 'function') {
        throw new LLMValidationError(`Adapter '${adapter.providerId}' must have a valid capabilities Set`);
      }
    }
    if (typeof adapter.streamText !== 'function') {
      throw new LLMValidationError(`Adapter '${adapter.providerId}' must implement streamText()`);
    }
    if (typeof adapter.generateText !== 'function') {
      throw new LLMValidationError(`Adapter '${adapter.providerId}' must implement generateText()`);
    }

    if (this.adapters.has(adapter.providerId)) {
      throw new LLMValidationError(
        `Adapter with providerId '${adapter.providerId}' is already registered`
      );
    }

    this.adapters.set(adapter.providerId, adapter);
  }

  /**
   * Registers a server-side model alias.
   */
  public registerAlias(config: ModelAliasConfig): void {
    if (!config || typeof config !== 'object') {
      throw new LLMValidationError('ModelAliasConfig must be an object');
    }
    if (!config.alias || typeof config.alias !== 'string' || !VALID_ALIAS_REGEX.test(config.alias)) {
      throw new LLMValidationError(
        `Invalid alias format: '${config.alias}'. Must contain only alphanumeric characters, hyphens, and underscores.`
      );
    }
    if (this.aliases.has(config.alias)) {
      throw new LLMValidationError(`Alias '${config.alias}' is already registered`);
    }
    if (!config.providerId || typeof config.providerId !== 'string' || config.providerId.trim() === '') {
      throw new LLMValidationError(`Alias '${config.alias}' must define a non-empty providerId`);
    }
    if (!config.modelId || typeof config.modelId !== 'string' || config.modelId.trim() === '') {
      throw new LLMValidationError(`Alias '${config.alias}' must define a non-empty modelId`);
    }
    if (!Array.isArray(config.requiredCapabilities) || config.requiredCapabilities.length === 0) {
      throw new LLMValidationError(`Alias '${config.alias}' must specify at least one required capability`);
    }
    for (const cap of config.requiredCapabilities) {
      if (!VALID_CAPABILITIES.has(cap)) {
        throw new LLMValidationError(`Alias '${config.alias}' contains invalid capability: '${cap}'`);
      }
    }
    if (config.maxOutputTokensLimit !== undefined) {
      if (
        typeof config.maxOutputTokensLimit !== 'number' ||
        !Number.isInteger(config.maxOutputTokensLimit) ||
        config.maxOutputTokensLimit <= 0
      ) {
        throw new LLMValidationError(
          `Alias '${config.alias}' maxOutputTokensLimit must be a positive integer`
        );
      }
    }
    if (config.reasoning !== undefined) {
      if (typeof config.reasoning !== 'object' || config.reasoning === null) {
        throw new LLMValidationError(`Alias '${config.alias}' reasoning must be an object`);
      }
      if (typeof config.reasoning.supported !== 'boolean') {
        throw new LLMValidationError(`Alias '${config.alias}' reasoning.supported must be a boolean`);
      }
      if (!Array.isArray(config.reasoning.efforts)) {
        throw new LLMValidationError(`Alias '${config.alias}' reasoning.efforts must be an array`);
      }
      for (const effort of config.reasoning.efforts) {
        if (!VALID_EFFORTS.has(effort)) {
          throw new LLMValidationError(`Alias '${config.alias}' contains invalid reasoning effort: '${effort}'`);
        }
      }
    }

    this.aliases.set(config.alias, { ...config });
  }

  /**
   * Checks if an alias is registered.
   */
  public hasAlias(alias: string): boolean {
    return this.aliases.has(alias);
  }

  /**
   * Gets the configuration for an alias if registered.
   */
  public getAliasConfig(alias: string): ModelAliasConfig | undefined {
    const config = this.aliases.get(alias);
    return config ? { ...config } : undefined;
  }

  /**
   * Gets a registered provider adapter by providerId.
   */
  public getAdapter(providerId: string): ProviderAdapter | undefined {
    return this.adapters.get(providerId);
  }

  /**
   * Returns reasoning capabilities for a registered model alias.
   * Defined per model, not globally per provider.
   */
  public getReasoningCapabilities(alias: string): ModelReasoningConfig {
    if (!alias || typeof alias !== 'string') {
      throw new UnknownModelAliasError(String(alias));
    }
    const config = this.aliases.get(alias);
    if (!config) {
      throw new UnknownModelAliasError(alias);
    }
    if (config.reasoning) {
      return { supported: config.reasoning.supported, efforts: [...config.reasoning.efforts] };
    }
    const adapter = this.adapters.get(config.providerId);
    if (adapter?.getReasoningCapabilities) {
      const adapterCapabilities = adapter.getReasoningCapabilities(config.modelId);
      if (adapterCapabilities) {
        return { supported: adapterCapabilities.supported, efforts: [...adapterCapabilities.efforts] };
      }
    }
    return { supported: false, efforts: [] };
  }

  /**
   * Lists all registered models with their trusted capabilities.
   */
  public listModels(): readonly ModelMetadata[] {
    const list: ModelMetadata[] = [];
    for (const [alias, config] of this.aliases.entries()) {
      list.push({
        id: alias,
        capabilities: [...config.requiredCapabilities],
        reasoning: this.getReasoningCapabilities(alias),
      });
    }
    return list;
  }

  /**
   * Resolves an alias and validates that the underlying provider adapter
   * is available and supports the requested capability.
   */
  public resolve(
    alias: string,
    requiredCapability?: Capability
  ): { adapter: ProviderAdapter; config: ModelAliasConfig } {
    if (!alias || typeof alias !== 'string') {
      throw new UnknownModelAliasError(String(alias));
    }

    const config = this.aliases.get(alias);
    if (!config) {
      throw new UnknownModelAliasError(alias);
    }

    if (requiredCapability) {
      if (!config.requiredCapabilities.includes(requiredCapability)) {
        throw new UnsupportedCapabilityError(requiredCapability, alias);
      }
    }

    const adapter = this.adapters.get(config.providerId);
    if (!adapter) {
      throw new ProviderUnavailableError(
        `Provider '${config.providerId}' configured for alias '${alias}' is not available`
      );
    }

    if (requiredCapability && !adapter.capabilities.has(requiredCapability)) {
      throw new UnsupportedCapabilityError(requiredCapability, adapter.providerId);
    }

    return { adapter, config };
  }

  /**
   * Performs a fail-fast validation check on all registered aliases.
   * Throws if any alias points to a missing adapter or unsupported capability.
   */
  public validate(): void {
    for (const [alias, config] of this.aliases.entries()) {
      const adapter = this.adapters.get(config.providerId);
      if (!adapter) {
        throw new ProviderUnavailableError(
          `Validation failed: Provider '${config.providerId}' for alias '${alias}' is not registered`
        );
      }
      for (const cap of config.requiredCapabilities) {
        if (!adapter.capabilities.has(cap)) {
          throw new UnsupportedCapabilityError(cap, `${alias} -> ${adapter.providerId}`);
        }
      }
      if (config.reasoning?.supported) {
        if (adapter.getReasoningCapabilities) {
          const adapterReasoning = adapter.getReasoningCapabilities(config.modelId);
          if (!adapterReasoning?.supported) {
            throw new UnsupportedCapabilityError('reasoning' as Capability, `${alias} -> ${adapter.providerId} (${config.modelId})`);
          }
          for (const effort of config.reasoning.efforts) {
            if (!adapterReasoning.efforts.includes(effort)) {
              throw new LLMValidationError(
                `Alias '${alias}' requires reasoning effort '${effort}', but adapter '${adapter.providerId}' model '${config.modelId}' does not support it`
              );
            }
          }
        }
      }
    }
  }
}

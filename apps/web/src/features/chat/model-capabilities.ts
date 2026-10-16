import type {
  Capability,
  ModelMetadata,
  ModelReasoningConfig,
  ReasoningEffort,
} from '../../lib/api/types.js';
import { VALID_REASONING_EFFORTS } from '../../lib/api/types.js';
export { VALID_REASONING_EFFORTS };

export function isValidReasoningEffort(val: unknown): val is ReasoningEffort {
  return typeof val === 'string' && VALID_REASONING_EFFORTS.includes(val as ReasoningEffort);
}

/**
 * Normalizes raw reasoning configuration from the model metadata API.
 * Strict fail-closed semantics:
 * - Missing or invalid object returns supported: false and empty efforts.
 * - Any efforts not recognized by frontend (VALID_REASONING_EFFORTS) are filtered out.
 * - If no recognized valid efforts exist, supported is set to false.
 */
export function normalizeReasoningConfig(raw: unknown): ModelReasoningConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { supported: false, efforts: [] };
  }
  const rawObj = raw as Record<string, unknown>;
  const supported = rawObj.supported === true;
  const rawEfforts = Array.isArray(rawObj.efforts) ? rawObj.efforts : [];
  const efforts = rawEfforts.filter((e): e is ReasoningEffort => isValidReasoningEffort(e));

  return {
    supported: supported && efforts.length > 0,
    efforts,
  };
}

/**
 * Normalizes raw model metadata from the GET /api/v1/models endpoint.
 */
export function normalizeModelMetadata(raw: unknown): ModelMetadata {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      id: '',
      capabilities: [],
      reasoning: { supported: false, efforts: [] },
    };
  }
  const rawObj = raw as Record<string, unknown>;
  const id = typeof rawObj.id === 'string' ? rawObj.id : '';
  const capabilities = Array.isArray(rawObj.capabilities)
    ? (rawObj.capabilities.filter((c) => typeof c === 'string') as Capability[])
    : [];
  const reasoning = normalizeReasoningConfig(rawObj.reasoning);

  return {
    id,
    capabilities,
    reasoning,
  };
}

/**
 * Determines whether a model supports reasoning controls.
 * Provider-agnostic: based solely on metadata capabilities, never on provider name.
 */
export function isReasoningSupported(model: ModelMetadata | undefined): boolean {
  if (!model) return false;
  return (
    model.reasoning?.supported === true &&
    Array.isArray(model.reasoning?.efforts) &&
    model.reasoning.efforts.length > 0
  );
}

/**
 * Returns the list of valid reasoning effort levels supported by the model.
 */
export function getSupportedReasoningEfforts(
  model: ModelMetadata | undefined
): readonly ReasoningEffort[] {
  if (!isReasoningSupported(model)) return [];
  return model!.reasoning.efforts;
}

/**
 * Returns the effective reasoning effort to include in a request.
 * If the model does not support reasoning or does not support the requested level,
 * returns undefined (so the field is omitted and model default policy applies).
 */
export function getEffectiveReasoningEffort(
  model: ModelMetadata | undefined,
  effort: ReasoningEffort | undefined
): ReasoningEffort | undefined {
  if (!effort) return undefined;
  if (!isReasoningSupported(model)) return undefined;
  return model!.reasoning.efforts.includes(effort) ? effort : undefined;
}

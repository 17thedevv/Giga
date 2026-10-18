// Dependency-free public response schemas. Keep declarations and fixtures in this directory.
export const AGENT_CAPABILITY_NAMES = Object.freeze([
  'workspaceManagement', 'runAdmission', 'runHistory', 'runExecution',
  'ask', 'plan', 'execute', 'durableMessages', 'followUp', 'eventReplay',
  'cancellation', 'sandboxFiles', 'artifacts', 'artifactDownload', 'externalApproval', 'cloudRuntime',
]);
const reasons = ['runtime_unavailable', 'not_implemented', 'unknown'];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid Agent response object');
  return value;
};
const string = (value) => {
  if (typeof value !== 'string') throw new TypeError('Invalid Agent response string');
  return value;
};
const oneOf = (value, values) => {
  if (!values.includes(value)) throw new TypeError('Invalid Agent response enum');
  return value;
};
const positiveInteger = (value) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid Agent response integer');
  return value;
};
const uuid = (value) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(string(value))) {
    throw new TypeError('Invalid Agent response ID');
  }
  return value;
};
const timestamp = (value) => {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(string(value)) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError('Invalid Agent response timestamp');
  }
  return value;
};
const array = (value, parse) => {
  if (!Array.isArray(value)) throw new TypeError('Invalid Agent response array');
  return value.map(parse);
};
const check = (value) => {
  const v = record(value);
  return { name: string(v.name), outcome: oneOf(v.outcome, ['passed', 'failed', 'not_run']),
    ...(v.summary === undefined ? {} : { summary: string(v.summary) }) };
};
export const agentWorkspaceSchema = Object.freeze({ parse(value) {
  const v = record(value);
  return { id: uuid(v.id), name: string(v.name), sourceKind: oneOf(v.sourceKind, ['blank']),
    revision: positiveInteger(v.revision), createdAt: timestamp(v.createdAt), updatedAt: timestamp(v.updatedAt) };
} });
export const agentRunSchema = Object.freeze({ parse(value) {
  const v = record(value);
  const result = { id: uuid(v.id), workspaceId: uuid(v.workspaceId), task: string(v.task),
    mode: oneOf(v.mode, ['ask', 'plan', 'execute']), runtime: oneOf(v.runtime, ['cloud']), modelId: string(v.modelId),
    status: oneOf(v.status, ['queued', 'running', 'awaiting_approval', 'applying', 'completed', 'failed', 'cancelled']),
    createdAt: timestamp(v.createdAt), updatedAt: timestamp(v.updatedAt) };
  if (v.phase !== undefined) result.phase = oneOf(v.phase, ['waiting_runtime', 'planning', 'executing', 'observing', 'verifying']);
  if (v.finishedAt !== undefined) result.finishedAt = timestamp(v.finishedAt);
  if (v.error !== undefined) {
    const error = record(v.error);
    result.error = { code: string(error.code), message: string(error.message) };
  }
  if (v.result !== undefined) {
    const output = record(v.result);
    result.result = { summary: string(output.summary), artifactIds: array(output.artifactIds, uuid),
      verifiedChecks: array(output.verifiedChecks, check) };
  }
  return result;
} });
export const agentMessageSchema = Object.freeze({ parse(value) {
  const v = record(value);
  return { id: uuid(v.id), workspaceId: uuid(v.workspaceId), runId: uuid(v.runId), sequence: positiveInteger(v.sequence),
    role: oneOf(v.role, ['user', 'assistant', 'tool_summary']), content: string(v.content), createdAt: timestamp(v.createdAt) };
} });

function capability(value) {
  const v = record(value);
  if (own(v, 'available') && v.available === true && v.reason === undefined) return { available: true };
  if (own(v, 'available') && v.available === false && own(v, 'reason') && reasons.includes(v.reason)) {
    return { available: false, reason: v.reason };
  }
  throw new TypeError('Invalid Agent capability metadata');
}

// Availability describes usable features, not interface existence. Do not let inconsistent
// metadata enable execution or dependents without their runtime/read prerequisites.
function dependencies(capabilities) {
  const unknown = () => ({ available: false, reason: 'unknown' });
  const require = (name, prerequisites) => {
    if (capabilities[name].available && prerequisites.some((key) => !capabilities[key].available)) {
      capabilities[name] = unknown();
    }
  };
  require('runExecution', ['cloudRuntime', 'runAdmission']);
  for (const name of ['ask', 'plan', 'execute']) require(name, ['runExecution']);
  require('followUp', ['runExecution', 'durableMessages']);
  require('artifactDownload', ['artifacts']);
  return capabilities;
}

export const agentCapabilitiesSchema = Object.freeze({ parse(value) {
  const v = record(value);
  if (v.schemaVersion !== 1) throw new TypeError('Unsupported Agent capability schema');
  const metadata = record(v.capabilities);
  const capabilities = Object.fromEntries(AGENT_CAPABILITY_NAMES.map((name) => {
    if (!own(metadata, name)) throw new TypeError('Missing Agent capability metadata');
    return [name, capability(metadata[name])];
  }));
  const normalized = dependencies(structuredClone(capabilities));
  if (JSON.stringify(normalized) !== JSON.stringify(capabilities)) throw new TypeError('Inconsistent Agent capabilities');
  return { schemaVersion: 1, capabilities };
} });

export function readAgentCapabilities(value) {
  let metadata = {};
  try {
    const v = record(value);
    if (v.schemaVersion === 1) metadata = record(v.capabilities);
  } catch { /* Unknown envelopes fail closed. */ }
  const capabilities = Object.fromEntries(AGENT_CAPABILITY_NAMES.map((name) => {
    try {
      if (!own(metadata, name)) throw new TypeError();
      return [name, capability(metadata[name])];
    } catch { return [name, { available: false, reason: 'unknown' }]; }
  }));
  return { schemaVersion: 1, capabilities: dependencies(capabilities) };
}

export function isAgentCapabilityAvailable(value, name) {
  return AGENT_CAPABILITY_NAMES.includes(name) && readAgentCapabilities(value).capabilities[name].available;
}

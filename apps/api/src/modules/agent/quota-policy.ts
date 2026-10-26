import type { AgentMode } from './types.js';

export interface AgentResourceLimits {
  readonly sandboxRuntimeMs: number;
  readonly wallClockMs: number;
  readonly toolCalls: number;
  readonly providerRequests: number;
  readonly commandOutputBytes: number;
  readonly artifactBytes: number;
  readonly workspaceDiskBytes: number;
  readonly workspaceFileCount: number;
}

export interface AgentDailyBudget {
  readonly sandboxRuntimeMs: number;
  readonly providerRequests: number;
  readonly commandOutputBytes: number;
  readonly artifactBytes: number;
}

export interface AgentQuotaPolicy {
  readonly version: number;
  readonly maxAttempts: number;
  readonly maxConcurrentWritableRunsPerOwner: number;
  readonly maxConcurrentWritableRunsPerWorkspace: number;
  readonly execute: AgentResourceLimits;
  readonly readOnly: AgentResourceLimits;
  readonly rolling24Hour: {
    readonly owner: AgentDailyBudget;
    readonly workspace: AgentDailyBudget;
  };
}

const MiB = 1024 * 1024;

/** Server-controlled defaults. Callers may inject a separately validated admin policy. */
export const DEFAULT_AGENT_QUOTA_POLICY: AgentQuotaPolicy = Object.freeze({
  version: 1,
  maxAttempts: 3,
  maxConcurrentWritableRunsPerOwner: 1,
  maxConcurrentWritableRunsPerWorkspace: 1,
  execute: Object.freeze({
    sandboxRuntimeMs: 30 * 60 * 1000,
    wallClockMs: 30 * 60 * 1000,
    toolCalls: 30,
    providerRequests: 60,
    commandOutputBytes: 2 * MiB,
    artifactBytes: 20 * MiB,
    workspaceDiskBytes: 100 * MiB,
    workspaceFileCount: 1000,
  }),
  readOnly: Object.freeze({
    sandboxRuntimeMs: 0,
    wallClockMs: 2 * 60 * 1000,
    toolCalls: 10,
    providerRequests: 20,
    commandOutputBytes: 256 * 1024,
    artifactBytes: 0,
    workspaceDiskBytes: 0,
    workspaceFileCount: 0,
  }),
  rolling24Hour: Object.freeze({
    owner: Object.freeze({
      sandboxRuntimeMs: 60 * 60 * 1000,
      providerRequests: 200,
      commandOutputBytes: 8 * MiB,
      artifactBytes: 80 * MiB,
    }),
    workspace: Object.freeze({
      sandboxRuntimeMs: 30 * 60 * 1000,
      providerRequests: 100,
      commandOutputBytes: 4 * MiB,
      artifactBytes: 40 * MiB,
    }),
  }),
});

const RESOURCE_KEYS: readonly (keyof AgentResourceLimits)[] = [
  'sandboxRuntimeMs',
  'wallClockMs',
  'toolCalls',
  'providerRequests',
  'commandOutputBytes',
  'artifactBytes',
  'workspaceDiskBytes',
  'workspaceFileCount',
];
const DAILY_KEYS: readonly (keyof AgentDailyBudget)[] = [
  'sandboxRuntimeMs',
  'providerRequests',
  'commandOutputBytes',
  'artifactBytes',
];

function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Agent quota policy: ' + label + ' must be an object');
  }
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    if (!keys.includes(key)) throw new Error('Invalid Agent quota policy: unknown ' + label + ' field');
  }
  return result;
}

function integer(value: unknown, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error('Invalid Agent quota policy: ' + label + ' is outside its safe integer range');
  }
  return value as number;
}

function parseResourceLimits(value: unknown, label: string): AgentResourceLimits {
  const input = record(value, label, RESOURCE_KEYS);
  const parsed = {} as Record<keyof AgentResourceLimits, number>;
  for (const key of RESOURCE_KEYS) parsed[key] = integer(input[key], label + '.' + key, 0);
  if (parsed.wallClockMs === 0) throw new Error('Invalid Agent quota policy: wallClockMs must be positive');
  return Object.freeze(parsed);
}

function parseDailyBudget(value: unknown, label: string): AgentDailyBudget {
  const input = record(value, label, DAILY_KEYS);
  const parsed = {} as Record<keyof AgentDailyBudget, number>;
  for (const key of DAILY_KEYS) parsed[key] = integer(input[key], label + '.' + key, 0);
  return Object.freeze(parsed);
}

function assertFitsDaily(limits: AgentResourceLimits, budget: AgentDailyBudget, label: string): void {
  for (const key of DAILY_KEYS) {
    if (limits[key] > budget[key]) {
      throw new Error('Invalid Agent quota policy: ' + label + '.' + key + ' is below a per-run limit');
    }
  }
}

export function validateAgentQuotaPolicy(value: unknown = DEFAULT_AGENT_QUOTA_POLICY): AgentQuotaPolicy {
  const input = record(value, 'policy', [
    'version',
    'maxAttempts',
    'maxConcurrentWritableRunsPerOwner',
    'maxConcurrentWritableRunsPerWorkspace',
    'execute',
    'readOnly',
    'rolling24Hour',
  ]);
  const window = record(input.rolling24Hour, 'rolling24Hour', ['owner', 'workspace']);
  const execute = parseResourceLimits(input.execute, 'execute');
  const readOnly = parseResourceLimits(input.readOnly, 'readOnly');
  const ownerBudget = parseDailyBudget(window.owner, 'rolling24Hour.owner');
  const workspaceBudget = parseDailyBudget(window.workspace, 'rolling24Hour.workspace');

  if (
    readOnly.sandboxRuntimeMs !== 0 ||
    readOnly.artifactBytes !== 0 ||
    readOnly.workspaceDiskBytes !== 0 ||
    readOnly.workspaceFileCount !== 0
  ) {
    throw new Error('Invalid Agent quota policy: readOnly mode cannot reserve write or sandbox capacity');
  }
  assertFitsDaily(execute, ownerBudget, 'rolling24Hour.owner');
  assertFitsDaily(execute, workspaceBudget, 'rolling24Hour.workspace');
  assertFitsDaily(readOnly, ownerBudget, 'rolling24Hour.owner');
  assertFitsDaily(readOnly, workspaceBudget, 'rolling24Hour.workspace');

  return Object.freeze({
    version: integer(input.version, 'version', 1, 1000),
    maxAttempts: integer(input.maxAttempts, 'maxAttempts', 1, 10),
    maxConcurrentWritableRunsPerOwner: integer(input.maxConcurrentWritableRunsPerOwner, 'maxConcurrentWritableRunsPerOwner', 1, 100),
    maxConcurrentWritableRunsPerWorkspace: integer(input.maxConcurrentWritableRunsPerWorkspace, 'maxConcurrentWritableRunsPerWorkspace', 1, 100),
    execute,
    readOnly,
    rolling24Hour: Object.freeze({ owner: ownerBudget, workspace: workspaceBudget }),
  });
}

export function resourceLimitsForMode(policy: AgentQuotaPolicy, mode: AgentMode): AgentResourceLimits {
  return mode === 'execute' ? policy.execute : policy.readOnly;
}

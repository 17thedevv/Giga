import type { AgentMode, ToolRisk } from './types.js';

export type ToolValueSchema =
  | { readonly type: 'string'; readonly maxLength: number; readonly minLength?: number; readonly pattern?: string }
  | { readonly type: 'array'; readonly maxItems: number; readonly items: { readonly type: 'string'; readonly maxLength: number } };

export interface ToolArgumentSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, ToolValueSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

export interface ToolDefinition<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly risk: ToolRisk;
  readonly argumentsSchema: ToolArgumentSchema;
  readonly validateArgs: (args: unknown) => { success: true; data: TArgs } | { success: false; error: string };
}

export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly risk: ToolRisk;
  readonly argumentsSchema: ToolArgumentSchema;
}

export type ToolValidationResult =
  | { readonly valid: true; readonly tool: ToolDefinition; readonly args: Record<string, unknown> }
  | {
      readonly valid: false;
      readonly errorCode: 'UNKNOWN_TOOL' | 'INVALID_ARGUMENTS' | 'POLICY_VIOLATION';
      readonly error: string;
      readonly tool?: ToolDefinition;
    };

const MAX_ARGUMENT_BYTES = 300 * 1024;
const MAX_ARGUMENT_DEPTH = 8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exceedsJsonDepth(value: unknown, depth = 0): boolean {
  if (depth > MAX_ARGUMENT_DEPTH) return true;
  if (Array.isArray(value)) return value.some((item) => exceedsJsonDepth(item, depth + 1));
  if (isPlainObject(value)) return Object.values(value).some((item) => exceedsJsonDepth(item, depth + 1));
  return false;
}

function safeRelativePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 1024) return undefined;
  if (value !== value.trim() || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return undefined;
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return undefined;
  return value;
}

export function isSafeRelativePath(value: unknown): value is string {
  return safeRelativePath(value) !== undefined;
}

function validateAgainstSchema(args: unknown, schema: ToolArgumentSchema): string | undefined {
  if (!isPlainObject(args)) return 'Arguments must be a plain object';
  const allowed = new Set(Object.keys(schema.properties));
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) return 'Unknown argument';
  }
  for (const required of schema.required ?? []) {
    if (!Object.hasOwn(args, required)) return 'Required argument is missing';
  }

  for (const [name, value] of Object.entries(args)) {
    const property = schema.properties[name];
    if (!property) return 'Unknown argument';
    if (property.type === 'string') {
      if (typeof value !== 'string') return 'Argument has the wrong type';
      if (value.includes('\0')) return 'Argument contains a malformed null byte';
      const bytes = Buffer.byteLength(value, 'utf8');
      if (bytes > property.maxLength || (property.minLength !== undefined && bytes < property.minLength)) return 'String argument exceeds its allowed size';
      if (property.pattern && !(new RegExp(property.pattern).test(value))) return 'String argument has an invalid format';
      continue;
    }
    if (property.type === 'array') {
      if (!Array.isArray(value) || value.length > property.maxItems) return 'List argument exceeds its allowed size';
      for (const item of value) {
        if (typeof item !== 'string' || item.includes('\0') || Buffer.byteLength(item, 'utf8') > property.items.maxLength) {
          return 'List contains an invalid or oversized string';
        }
      }
    }
  }
  if (exceedsJsonDepth(args)) return 'Arguments exceed the maximum nesting depth';

  try {
    if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_ARGUMENT_BYTES) return 'Arguments exceed the maximum size';
  } catch {
    return 'Arguments are not valid JSON data';
  }
  return undefined;
}

export function isToolAllowedInMode(mode: AgentMode, risk: ToolRisk): boolean {
  switch (mode) {
    case 'ask':
    case 'plan':
      return risk === 'read';
    case 'execute':
      return true;
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register<TArgs extends Record<string, unknown>>(tool: ToolDefinition<TArgs>): this {
    if (!tool || !/^[a-z][a-z0-9_]{0,63}$/.test(tool.name) || this.tools.has(tool.name)) {
      throw new Error('Tool name is invalid or already registered');
    }
    if (typeof tool.description !== 'string' || tool.description.length === 0 || Buffer.byteLength(tool.description, 'utf8') > 512) {
      throw new Error('Tool description is invalid');
    }
    if (!tool.argumentsSchema || tool.argumentsSchema.type !== 'object' || tool.argumentsSchema.additionalProperties !== false) {
      throw new Error('Tool arguments must use a strict object schema');
    }
    if (typeof tool.validateArgs !== 'function') throw new Error('Tool validator is required');
    this.tools.set(tool.name, tool as unknown as ToolDefinition);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): readonly ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  listForMode(mode: AgentMode): readonly ModelToolDefinition[] {
    return this.list().filter((tool) => isToolAllowedInMode(mode, tool.risk)).map((tool) => ({
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      argumentsSchema: tool.argumentsSchema,
    }));
  }

  validate(name: string, args: unknown, mode: AgentMode): ToolValidationResult {
    const tool = this.tools.get(name);
    if (!tool) {
      return { valid: false, errorCode: 'UNKNOWN_TOOL', error: 'Tool is not present in the server registry' };
    }
    if (!isToolAllowedInMode(mode, tool.risk)) {
      return {
        valid: false,
        errorCode: 'POLICY_VIOLATION',
        error: 'Tool is not permitted in the current Agent mode',
        tool,
      };
    }
    const schemaError = validateAgainstSchema(args, tool.argumentsSchema);
    if (schemaError) {
      return { valid: false, errorCode: 'INVALID_ARGUMENTS', error: schemaError, tool };
    }
    const validation = tool.validateArgs(args);
    if (!validation.success) {
      return {
        valid: false,
        errorCode: 'INVALID_ARGUMENTS',
        error: 'Arguments do not satisfy the registered tool schema',
        tool,
      };
    }
    return { valid: true, tool, args: validation.data };
  }
}

const string = (maxLength: number, minLength?: number): ToolValueSchema => ({
  type: 'string', maxLength, ...(minLength === undefined ? {} : { minLength }),
});
const strictObject = (
  properties: Readonly<Record<string, ToolValueSchema>>,
  required: readonly string[] = [],
): ToolArgumentSchema => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });
export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register<{ path?: string }>({
    name: 'list_files',
    description: 'Lists files in the authorized workspace directory.',
    risk: 'read',
    argumentsSchema: strictObject({ path: string(1024) }),
    validateArgs(args: unknown) {
      const record = args as Record<string, unknown>;
      if (record.path === undefined) return { success: true, data: {} };
      const path = safeRelativePath(record.path);
      return path ? { success: true, data: { path } } : { success: false, error: 'Path must be canonical and workspace-relative' };
    },
  });

  registry.register<{ path: string }>({
    name: 'read_file',
    description: 'Reads bounded text from a file in the authorized workspace.',
    risk: 'read',
    argumentsSchema: strictObject({ path: string(1024) }, ['path']),
    validateArgs(args: unknown) {
      const path = safeRelativePath((args as Record<string, unknown>).path);
      return path ? { success: true, data: { path } } : { success: false, error: 'Path must be canonical and workspace-relative' };
    },
  });

  registry.register<{ path: string; content: string }>({
    name: 'write_file',
    description: 'Writes bounded text to a file inside the authorized workspace. Execute mode only.',
    risk: 'sandbox_write',
    argumentsSchema: strictObject({ path: string(1024), content: string(256 * 1024) }, ['path', 'content']),
    validateArgs(args: unknown) {
      const record = args as Record<string, unknown>;
      const path = safeRelativePath(record.path);
      if (!path) return { success: false, error: 'Path must be canonical and workspace-relative' };
      return { success: true, data: { path, content: record.content as string } };
    },
  });

  registry.register<{ path: string; find: string; replace: string }>({
    name: 'edit_file',
    description: 'Replaces bounded text in an existing authorized workspace file. Execute mode only.',
    risk: 'sandbox_write',
    argumentsSchema: strictObject({ path: string(1024), find: string(128 * 1024, 1), replace: string(128 * 1024) }, ['path', 'find', 'replace']),
    validateArgs(args: unknown) {
      const record = args as Record<string, unknown>;
      const path = safeRelativePath(record.path);
      if (!path) return { success: false, error: 'Path must be canonical and workspace-relative' };
      return { success: true, data: { path, find: record.find as string, replace: record.replace as string } };
    },
  });

  registry.register<{ command?: string }>({
    name: 'run_build',
    description: 'Runs the sandbox build operation. Execute mode only.',
    risk: 'sandbox_execute',
    argumentsSchema: strictObject({ command: string(256) }),
    validateArgs(args: unknown) {
      const command = (args as Record<string, unknown>).command;
      if (command === undefined) return { success: true, data: {} };
      if (typeof command !== 'string' || command.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(command)) {
        return { success: false, error: 'Build command is malformed' };
      }
      return { success: true, data: { command: command.trim() } };
    },
  });

  registry.register<{ testFilter?: string }>({
    name: 'run_tests',
    description: 'Runs the sandbox test operation. Execute mode only.',
    risk: 'sandbox_execute',
    argumentsSchema: strictObject({ testFilter: string(256) }),
    validateArgs(args: unknown) {
      const filter = (args as Record<string, unknown>).testFilter;
      if (filter === undefined) return { success: true, data: {} };
      if (typeof filter !== 'string' || /["'`;$&|<>\\\r\n\u0000]/.test(filter)) {
        return { success: false, error: 'Test filter contains unsupported characters' };
      }
      return { success: true, data: { testFilter: filter.trim() } };
    },
  });

  registry.register<{ command: string; args?: string[] }>({
    name: 'run_command',
    description: 'Runs a bounded command inside the isolated workspace runtime. Execute mode only.',
    risk: 'sandbox_execute',
    argumentsSchema: strictObject({
      command: string(512, 1),
      args: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 1024 } },
    }, ['command']),
    validateArgs(args: unknown) {
      const record = args as Record<string, unknown>;
      const command = record.command as string;
      if (command.trim().length === 0 || command !== command.trim() || /[\u0000-\u001f\u007f]/.test(command)) {
        return { success: false, error: 'Command is malformed' };
      }
      return { success: true, data: { command, ...(record.args === undefined ? {} : { args: record.args as string[] }) } };
    },
  });

  return registry;
}

import type { AgentMode, ToolRisk } from './types.js';

export interface ToolDefinition<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly risk: ToolRisk;
  readonly validateArgs: (args: unknown) => { success: true; data: TArgs } | { success: false; error: string };
}

export type ToolValidationResult =
  | { readonly valid: true; readonly tool: ToolDefinition; readonly args: Record<string, unknown> }
  | {
      readonly valid: false;
      readonly errorCode: 'UNKNOWN_TOOL' | 'INVALID_ARGUMENTS' | 'POLICY_VIOLATION';
      readonly error: string;
      readonly tool?: ToolDefinition;
    };

function isSafeRelativePath(p: unknown): p is string {
  if (typeof p !== 'string') return false;
  const trimmed = p.trim();
  if (trimmed.length === 0 || trimmed.length > 1024) return false;
  if (trimmed.includes('\0')) return false;
  // Disallow absolute paths, drive letters, and traversal
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[a-zA-Z]:/.test(trimmed)) return false;
  const segments = trimmed.split(/[/\\]/);
  for (const seg of segments) {
    if (seg === '..' || seg === '') return false;
  }
  return true;
}

export function isToolAllowedInMode(mode: AgentMode, risk: ToolRisk): boolean {
  switch (mode) {
    case 'ask':
      // Ask mode: no writes, no execution
      return risk === 'read';
    case 'plan':
      // Plan mode: read-only
      return risk === 'read';
    case 'execute':
      // Execute mode: fake sandbox writes/execution allowed through runtime abstraction
      return true;
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register<TArgs extends Record<string, unknown>>(tool: ToolDefinition<TArgs>): this {
    this.tools.set(tool.name, tool as unknown as ToolDefinition);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): readonly ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  validate(name: string, args: unknown, mode: AgentMode): ToolValidationResult {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        valid: false,
        errorCode: 'UNKNOWN_TOOL',
        error: `Tool '${name}' is not recognized in the registry`,
      };
    }

    if (!isToolAllowedInMode(mode, tool.risk)) {
      return {
        valid: false,
        errorCode: 'POLICY_VIOLATION',
        error: `Tool '${tool.name}' with risk '${tool.risk}' is not permitted in '${mode}' mode`,
        tool,
      };
    }

    const validation = tool.validateArgs(args);
    if (!validation.success) {
      return {
        valid: false,
        errorCode: 'INVALID_ARGUMENTS',
        error: `Invalid arguments for tool '${tool.name}': ${validation.error}`,
        tool,
      };
    }

    return {
      valid: true,
      tool,
      args: validation.data,
    };
  }
}

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register<{ path?: string }>({
    name: 'list_files',
    description: 'Lists files in the workspace directory',
    risk: 'read',
    validateArgs(args: unknown) {
      if (args === undefined || args === null) return { success: true, data: {} };
      if (typeof args !== 'object' || Array.isArray(args)) {
        return { success: false, error: 'Arguments must be an object' };
      }
      const record = args as Record<string, unknown>;
      if ('path' in record && record.path !== undefined) {
        if (!isSafeRelativePath(record.path)) {
          return { success: false, error: "Optional 'path' must be a valid relative path without traversal" };
        }
        return { success: true, data: { path: (record.path as string).trim() } };
      }
      return { success: true, data: {} };
    },
  });

  registry.register<{ path: string }>({
    name: 'read_file',
    description: 'Reads the content of a file in the workspace',
    risk: 'read',
    validateArgs(args: unknown) {
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        return { success: false, error: 'Arguments must be an object' };
      }
      const record = args as Record<string, unknown>;
      if (!isSafeRelativePath(record.path)) {
        return { success: false, error: "Required 'path' must be a valid relative path without traversal" };
      }
      return { success: true, data: { path: (record.path as string).trim() } };
    },
  });

  registry.register<{ path: string; content: string }>({
    name: 'write_file',
    description: 'Writes content to a file in the workspace',
    risk: 'sandbox_write',
    validateArgs(args: unknown) {
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        return { success: false, error: 'Arguments must be an object' };
      }
      const record = args as Record<string, unknown>;
      if (!isSafeRelativePath(record.path)) {
        return { success: false, error: "Required 'path' must be a valid relative path without traversal" };
      }
      if (typeof record.content !== 'string') {
        return { success: false, error: "Required 'content' must be a string" };
      }
      if (record.content.length > 256 * 1024) {
        return { success: false, error: "File 'content' exceeds maximum size of 256KB" };
      }
      return { success: true, data: { path: (record.path as string).trim(), content: record.content } };
    },
  });

  registry.register<{ path: string; find: string; replace: string }>({
    name: 'edit_file',
    description: 'Replaces target text within an existing file in the workspace',
    risk: 'sandbox_write',
    validateArgs(args: unknown) {
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        return { success: false, error: 'Arguments must be an object' };
      }
      const record = args as Record<string, unknown>;
      if (!isSafeRelativePath(record.path)) {
        return { success: false, error: "Required 'path' must be a valid relative path without traversal" };
      }
      if (typeof record.find !== 'string' || record.find.length === 0) {
        return { success: false, error: "Required 'find' must be a non-empty string" };
      }
      if (typeof record.replace !== 'string') {
        return { success: false, error: "Required 'replace' must be a string" };
      }
      return {
        success: true,
        data: {
          path: (record.path as string).trim(),
          find: record.find,
          replace: record.replace,
        },
      };
    },
  });

  registry.register<{ command?: string }>({
    name: 'run_build',
    description: 'Executes a build in the isolated sandbox',
    risk: 'sandbox_execute',
    validateArgs(args: unknown) {
      if (args === undefined || args === null) return { success: true, data: {} };
      if (typeof args !== 'object' || Array.isArray(args)) {
        return { success: false, error: 'Arguments must be an object' };
      }
      const record = args as Record<string, unknown>;
      if ('command' in record && record.command !== undefined) {
        if (typeof record.command !== 'string' || record.command.length > 256) {
          return { success: false, error: "Optional 'command' must be a string <= 256 chars" };
        }
        return { success: true, data: { command: record.command.trim() } };
      }
      return { success: true, data: {} };
    },
  });

  registry.register<{ testFilter?: string }>({
    name: 'run_tests',
    description: 'Executes test suite in the isolated sandbox',
    risk: 'sandbox_execute',
    validateArgs(args: unknown) {
      if (args === undefined || args === null) return { success: true, data: {} };
      if (typeof args !== 'object' || Array.isArray(args)) {
        return { success: false, error: 'Arguments must be an object' };
      }
      const record = args as Record<string, unknown>;
      if ('testFilter' in record && record.testFilter !== undefined) {
        if (typeof record.testFilter !== 'string' || record.testFilter.length > 256) {
          return { success: false, error: "Optional 'testFilter' must be a string <= 256 chars" };
        }
        return { success: true, data: { testFilter: record.testFilter.trim() } };
      }
      return { success: true, data: {} };
    },
  });

  return registry;
}

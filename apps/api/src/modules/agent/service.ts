import { createHash } from 'node:crypto';
import type { AgentRepository } from './repository.js';
import { idempotencyKey, runInput, workspaceInput } from './validation.js';
import type { AgentRun, AgentWorkspace } from './types.js';

/** Control-plane admission only. ExecutionRuntime.prepare is reserved for a later durable worker. */
export class AgentService {
  constructor(readonly repository: AgentRepository) {}
  createWorkspace(ownerId: string, body: unknown): Promise<AgentWorkspace> {
    return this.repository.createWorkspace(ownerId, workspaceInput(body).name);
  }
  createRun(ownerId: string, body: unknown, key: string | undefined): Promise<{ run: AgentRun; duplicate: boolean }> {
    const input = runInput(body);
    const fingerprint = createHash('sha256').update(JSON.stringify([
      input.workspaceId, input.task, input.mode, input.runtime, input.modelId,
    ])).digest('hex');
    return this.repository.admitRun(ownerId, input, idempotencyKey(key), fingerprint);
  }
}

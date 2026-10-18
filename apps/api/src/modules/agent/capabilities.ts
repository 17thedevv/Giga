import { agentCapabilitiesSchema, type AgentCapabilities } from '../../../../../packages/contracts/agent.js';

/** Mirrors createApp -> AgentService -> admitRun: no execution worker/provider is wired.
 * Fake runtimes, adapter interfaces, Chat config and client input cannot enable features.
 * A future runtime integration must change this mapping and its admission tests together.
 */
export function getAgentCapabilities(): AgentCapabilities {
  const available = { available: true } as const;
  const runtimeDisabled = { available: false, reason: 'runtime_unavailable' } as const;
  const proposed = { available: false, reason: 'not_implemented' } as const;
  const response: AgentCapabilities = {
    schemaVersion: 1,
    capabilities: {
      workspaceManagement: available,
      runAdmission: available,
      runHistory: available,
      runExecution: runtimeDisabled,
      ask: runtimeDisabled,
      plan: runtimeDisabled,
      execute: runtimeDisabled,
      durableMessages: available,
      followUp: runtimeDisabled,
      eventReplay: available,
      cancellation: proposed,
      sandboxFiles: proposed,
      artifacts: proposed,
      artifactDownload: proposed,
      externalApproval: proposed,
      cloudRuntime: runtimeDisabled,
    },
  };
  return agentCapabilitiesSchema.parse(response);
}

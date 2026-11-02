// Test-only entrypoint, bind-mounted by compose.fixture.yaml; excluded from the image.
// This deterministic adapter never contacts an AI provider or allocates a sandbox.
import { setTimeout as delay } from 'node:timers/promises';
import { start } from '../start.mjs';
import { LLMEngine } from '../../../apps/api/dist/modules/llm/engine.js';
import { ModelRegistry } from '../../../apps/api/dist/modules/llm/registry.js';

if (process.env.GIGA_DOCKER_FIXTURE !== 'deterministic-sse-only') {
  throw new Error('The Docker fixture requires its explicit test-only override');
}
const registry = new ModelRegistry();
registry.registerAdapter({
  providerId: 'docker-deterministic-fixture',
  capabilities: new Set(['text', 'streaming']),
  async *streamText(request) {
    for (const text of ['Deterministic', ' Docker', ' fixture.']) {
      await delay(600, undefined, { signal: request.signal });
      yield { type: 'text.delta', text };
    }
    yield { type: 'completed', finishReason: 'stop' };
  },
  async generateText() { throw new Error('Fixture supports streaming only'); },
});
registry.registerAlias({
  alias: 'giga-chat-default', providerId: 'docker-deterministic-fixture',
  modelId: 'fixture-only', requiredCapabilities: ['text', 'streaming'],
  maxOutputTokensLimit: 2048,
});
registry.validate();
await start({ llmEngine: new LLMEngine(registry) });

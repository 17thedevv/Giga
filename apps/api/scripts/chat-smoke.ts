// Manual only: reads server environment. Never prints prompt, response, key or HTTP errors.
import { createChatEngine, loadChatConfig } from '../src/modules/llm/chat-bootstrap.js';

try {
  const config = loadChatConfig(process.env, false);
  if (!config) throw new Error('Set GEMINI_API_KEY and CHAT_MODEL_ID and enable Chat to run smoke');
  const engine = createChatEngine({ ...config, maxOutputTokens: 64 })!;
  let completed = false; let usageAvailable = false;
  for await (const event of engine.streamText({ modelAlias: 'giga-chat-default', messages: [{ role: 'user', content: 'Reply with OK.' }],
    maxOutputTokens: 64, requestId: 'manual-chat-smoke', caller: 'chat', signal: AbortSignal.timeout(20000) })) {
    if (event.type === 'usage') usageAvailable = true;
    if (event.type === 'completed') completed = true;
  }
  if (!completed) throw new Error('Smoke did not complete');
  console.log(JSON.stringify({ provider: 'gemini', alias: 'giga-chat-default', completed, usageAvailable }));
} catch {
  console.error('Chat smoke failed; check server configuration, account access and network');
  process.exitCode = 1;
}

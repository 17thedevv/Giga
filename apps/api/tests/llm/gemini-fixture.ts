export function geminiFrame(text?: string, finishReason?: string, usageMetadata?: Record<string, number>): string {
  return `data: ${JSON.stringify({ candidates: [{ index: 0, ...(text === undefined ? {} : { content: { role: 'model', parts: [{ text }] } }),
    ...(finishReason ? { finishReason } : {}) }], ...(usageMetadata ? { usageMetadata } : {}) })}\n\n`;
}
export function providerResponse(text = geminiFrame('Hello') + geminiFrame(' world', 'STOP', { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 8, thoughtsTokenCount: 1 }), split = 0): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    if (!split) controller.enqueue(bytes);
    else for (let i = 0; i < bytes.length; i += split) controller.enqueue(bytes.slice(i, i + split));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}

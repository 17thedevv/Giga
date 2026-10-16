import type { AgentRepository } from './repository.js';
import { isTerminal, type AgentEvent } from './types.js';

export interface ObserverOptions { readonly pollMs?: number; readonly heartbeatMs?: number; readonly maxConnectionMs?: number }
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}
/** A bounded, backpressure-aware DB observer, independent of run execution lifetime. */
export function observeEvents(repository: AgentRepository, ownerId: string, id: string, after: number,
  requestSignal: AbortSignal, options: ObserverOptions = {}): Response {
  const controller = new AbortController();
  const stop = (): void => { controller.abort(); requestSignal.removeEventListener('abort', stop); };
  requestSignal.addEventListener('abort', stop, { once: true });
  if (requestSignal.aborted) stop();
  const start = Date.now(); let heartbeat = start; let cursor = after;
  let pending: AgentEvent[] = [];
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        while (!controller.signal.aborted && Date.now() - start < (options.maxConnectionMs ?? 60000)) {
          const event = pending.shift();
          if (event) {
            cursor = event.sequence;
            stream.enqueue(encoder.encode(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`));
            return;
          }
          const page = await repository.events(ownerId, id, cursor);
          if (controller.signal.aborted) break;
          if (page.items.length) { pending = page.items; continue; }
          if (isTerminal(page.status) && cursor >= page.lastEventId) break;
          if (Date.now() - heartbeat >= (options.heartbeatMs ?? 15000)) {
            heartbeat = Date.now();
            // No ID and no persistence: this is connection keepalive, never business state.
            stream.enqueue(encoder.encode('event: heartbeat\ndata: {}\n\n'));
            return;
          }
          await pause(options.pollMs ?? 500, controller.signal);
        }
        stop();
        try { stream.close(); } catch { /* the consumer may already have cancelled */ }
      } catch {
        stop();
        try { stream.close(); } catch { /* already cancelled */ }
      } // Reconcile through GET/replay after a read failure; never invent events.
    },
    cancel() { stop(); pending = []; },
  }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' } });
}

import { ProviderCredential } from './provider-credential.js';
import type { ProviderTransport } from './providers/gemini/gemini-provider.js';

/** Backend-only pool. No retries after accepting a successful HTTP stream. */
export class GeminiKeyPool {
  #entries: { credential: ProviderCredential; readyAt: number; disabled: boolean }[];
  #cursor = 0;
  constructor(keys: readonly string[], private readonly now: () => number = Date.now) {
    if (!keys.length || keys.length > 8) throw new Error('Invalid Gemini key pool configuration');
    this.#entries = [...new Set(keys)].map(key => ({ credential: new ProviderCredential(key, 'platform'), readyAt: 0, disabled: false }));
  }
  toJSON(): object { return { configured: true }; }

  async request(transport: ProviderTransport, url: string, init: RequestInit): Promise<Response> {
    const attempted = new Set<number>();
    while (attempted.size < this.#entries.length) {
      init.signal?.throwIfAborted();
      let selected = -1;
      for (let offset = 0; offset < this.#entries.length; offset++) {
        const index = (this.#cursor + offset) % this.#entries.length;
        const entry = this.#entries[index]!;
        if (!attempted.has(index) && !entry.disabled && entry.readyAt <= this.now()) { selected = index; break; }
      }
      if (selected < 0) break;
      const entry = this.#entries[selected]!;
      this.#cursor = (selected + 1) % this.#entries.length;
      attempted.add(selected);
      const headers = new Headers(init.headers);
      for (const [name, value] of Object.entries(entry.credential.transportHeaders())) headers.set(name, value);
      // Transport exceptions propagate to the adapter's sanitization boundary;
      // they are not replayed because the upstream may have accepted the request.
      const response = await transport(url, { ...init, headers });
      if (init.signal?.aborted) { void response.body?.cancel().catch(() => {}); init.signal.throwIfAborted(); }
      if (response.status !== 429 && response.status !== 401 && response.status !== 403) return response;
      if (response.status === 429) {
        const raw = response.headers.get('retry-after');
        const delay = raw === null ? 30000 : /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - this.now();
        // Do not shorten a provider's Retry-After. A malformed header uses 30s.
        entry.readyAt = this.now() + (Number.isFinite(delay) ? Math.max(1000, delay) : 30000);
      } else entry.disabled = true;
      void response.body?.cancel().catch(() => {});
    }
    init.signal?.throwIfAborted();
    const cooling = this.#entries.filter(entry => !entry.disabled);
    if (!cooling.length) return new Response(null, { status: 403 });
    const waitMs = Math.max(1000, Math.min(...cooling.map(entry => entry.readyAt - this.now())));
    return new Response(null, { status: 429, headers: { 'Retry-After': String(Math.ceil(waitMs / 1000)) } });
  }
}

/** Internal transport capability. Never attach to requests, context, or public DTOs. */
export class ProviderCredential {
  readonly providerId = 'gemini';
  #apiKey: string;
  constructor(apiKey: string, readonly source: 'platform' | 'user', readonly credentialId?: string) {
    if (!/^[\x21-\x7e]{16,512}$/.test(apiKey)) throw new Error('Invalid provider credential');
    this.#apiKey = apiKey;
    Object.freeze(this);
  }
  transportHeaders(): Record<string, string> { return { 'x-goog-api-key': this.#apiKey }; }
  toJSON(): object { return { source: this.source }; }
}

export type CredentialResolver = () => Promise<ProviderCredential | undefined>;

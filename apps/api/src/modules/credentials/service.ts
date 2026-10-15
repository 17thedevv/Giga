import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { AppError, NotFoundError, ValidationError } from '../auth/auth-validation.js';
import { ProviderCredential } from '../llm/provider-credential.js';
import { BYOKCredentialInvalidError, ChatCredentialUnavailableError } from '../llm/errors.js';
import { CHAT_MODEL_ID, type ProviderTransport } from '../llm/providers/gemini/gemini-provider.js';
import { CredentialEncryption, credentialUnavailable, type EncryptedCredential } from './encryption.js';

export interface CredentialMetadata {
  id: string;
  provider: 'gemini';
  displayHint: string;
  status: 'unverified' | 'valid' | 'invalid';
  createdAt: string;
  updatedAt: string;
  lastValidatedAt: string | null;
}
interface CredentialRow extends EncryptedCredential {
  id: string;
  display_hint: string;
  status: CredentialMetadata['status'];
  created_at: Date;
  updated_at: Date;
  last_validated_at: Date | null;
}
export interface ChatCredentialPreference { mode: 'platform' | 'byok'; credentialId: string | null }
const metadataColumns = 'id, display_hint, status, created_at, updated_at, last_validated_at';
function metadata(row: CredentialRow): CredentialMetadata {
  return { id: row.id, provider: 'gemini', displayHint: row.display_hint, status: row.status,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    lastValidatedAt: row.last_validated_at?.toISOString() ?? null };
}

/** Only this Chat service has DB + decryption authority; never inject into Agent/Skills. */
export class ChatCredentialsService {
  constructor(private readonly pool: pg.Pool, private readonly encryption?: CredentialEncryption,
    private readonly platform?: ProviderCredential, private readonly transport: ProviderTransport = fetch) {}

  private async safe<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof AppError) throw error;
      throw credentialUnavailable(); // DB errors may contain bound ciphertext; never log/copy cause.
    }
  }

  private async transaction<T>(ownerId: string, operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.safe(async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        // Stable owner lock serializes replacement, deletion and preference selection,
        // including the first insert where no credential/preference row exists yet.
        const owner = await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [ownerId]);
        if (!owner.rows.length) throw new NotFoundError();
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    });
  }

  list(ownerId: string): Promise<CredentialMetadata[]> {
    return this.safe(async () => (await this.pool.query<CredentialRow>(
      `SELECT ${metadataColumns} FROM user_provider_credentials WHERE owner_id=$1`, [ownerId])).rows.map(metadata));
  }

  save(ownerId: string, provider: unknown, apiKey: unknown): Promise<CredentialMetadata> {
    if (provider !== 'gemini' || typeof apiKey !== 'string' || !/^[\x21-\x7e]{16,512}$/.test(apiKey)) {
      throw new ValidationError('Expected Gemini provider and a printable credential of 16 to 512 characters');
    }
    if (!this.encryption) throw credentialUnavailable();
    const id = randomUUID();
    const encrypted = this.encryption.encrypt(apiKey, ownerId, id);
    const hint = `••••${apiKey.slice(-4)}`;
    return this.transaction(ownerId, async (client) => {
      await client.query('UPDATE chat_credential_preferences SET credential_id=NULL WHERE owner_id=$1', [ownerId]);
      await client.query('DELETE FROM user_provider_credentials WHERE owner_id=$1', [ownerId]);
      const saved = await client.query<CredentialRow>(`INSERT INTO user_provider_credentials
        (id,owner_id,provider_id,ciphertext,nonce,auth_tag,key_version,display_hint)
        VALUES ($1,$2,'gemini',$3,$4,$5,$6,$7) RETURNING ${metadataColumns}`,
      [id, ownerId, encrypted.ciphertext, encrypted.nonce, encrypted.auth_tag, encrypted.key_version, hint]);
      await client.query("UPDATE chat_credential_preferences SET credential_id=$2,updated_at=NOW() WHERE owner_id=$1 AND mode='byok'", [ownerId, id]);
      return metadata(saved.rows[0]!);
    });
  }

  delete(ownerId: string, id: string): Promise<void> {
    return this.transaction(ownerId, async (client) => {
      const found = await client.query('SELECT id FROM user_provider_credentials WHERE owner_id=$1 AND id=$2', [ownerId, id]);
      if (!found.rows.length) throw new NotFoundError();
      await client.query('UPDATE chat_credential_preferences SET credential_id=NULL,updated_at=NOW() WHERE owner_id=$1 AND credential_id=$2', [ownerId, id]);
      await client.query('DELETE FROM user_provider_credentials WHERE owner_id=$1 AND id=$2', [ownerId, id]);
    });
  }

  preference(ownerId: string): Promise<ChatCredentialPreference> {
    return this.safe(async () => {
      const result = await this.pool.query<{ mode: ChatCredentialPreference['mode']; credential_id: string | null }>(
        'SELECT mode,credential_id FROM chat_credential_preferences WHERE owner_id=$1', [ownerId]);
      return result.rows[0] ? { mode: result.rows[0].mode, credentialId: result.rows[0].credential_id } : { mode: 'platform', credentialId: null };
    });
  }

  setPreference(ownerId: string, mode: unknown, credentialId: unknown): Promise<ChatCredentialPreference> {
    if ((mode !== 'platform' && mode !== 'byok') || (mode === 'platform' && credentialId !== undefined && credentialId !== null)
      || (mode === 'byok' && typeof credentialId !== 'string')) throw new ValidationError('Invalid Chat credential preference');
    return this.transaction(ownerId, async (client) => {
      if (mode === 'byok') {
        const found = await client.query('SELECT id FROM user_provider_credentials WHERE owner_id=$1 AND id=$2', [ownerId, credentialId]);
        if (!found.rows.length) throw new NotFoundError();
      }
      await client.query(`INSERT INTO chat_credential_preferences (owner_id,mode,credential_id) VALUES ($1,$2,$3)
        ON CONFLICT (owner_id) DO UPDATE SET mode=EXCLUDED.mode,credential_id=EXCLUDED.credential_id,updated_at=NOW()`,
      [ownerId, mode, mode === 'byok' ? credentialId : null]);
      return { mode, credentialId: mode === 'byok' ? credentialId as string : null };
    });
  }

  resolve(ownerId: string): Promise<ProviderCredential | undefined> {
    return this.safe(async () => {
      // One MVCC statement snapshots preference + immutable encrypted row together.
      // Replacement/deletion after this SELECT affects future calls only.
      const result = await this.pool.query<CredentialRow & { mode: string }>(`SELECT p.mode,c.*
        FROM chat_credential_preferences p LEFT JOIN user_provider_credentials c
        ON c.owner_id=p.owner_id AND c.id=p.credential_id WHERE p.owner_id=$1`, [ownerId]);
      const row = result.rows[0];
      if (!row || row.mode === 'platform') return this.platform;
      if (!row.id || !this.encryption) throw credentialUnavailable();
      if (row.status === 'invalid') throw new AppError('BYOK_CREDENTIAL_INVALID', 'The selected Chat credential was rejected', 422);
      const credential = new ProviderCredential(this.encryption.decrypt(row, ownerId, row.id), 'user', row.id);
      await this.pool.query('UPDATE user_provider_credentials SET last_used_at=NOW() WHERE owner_id=$1 AND id=$2', [ownerId, row.id]);
      return credential;
    }).catch((error: unknown) => {
      if (error instanceof AppError && error.code === 'BYOK_CREDENTIAL_INVALID') throw new BYOKCredentialInvalidError();
      throw new ChatCredentialUnavailableError();
    });
  }

  validate(ownerId: string, id: string, signal: AbortSignal): Promise<CredentialMetadata> {
    return this.safe(async () => {
      const found = await this.pool.query<CredentialRow>('SELECT * FROM user_provider_credentials WHERE owner_id=$1 AND id=$2', [ownerId, id]);
      const row = found.rows[0];
      if (!row) throw new NotFoundError();
      if (!this.encryption) throw credentialUnavailable();
      const credential = new ProviderCredential(this.encryption.decrypt(row, ownerId, id), 'user', id);
      let response: Response;
      const timeoutSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
      let onAbort: () => void = () => {};
      try {
        if (timeoutSignal.aborted) throw credentialUnavailable();
        response = await Promise.race([
          this.transport(`https://generativelanguage.googleapis.com/v1beta/models/${CHAT_MODEL_ID}`, {
            method: 'GET', redirect: 'error', headers: credential.transportHeaders(), signal: timeoutSignal,
          }).then((res) => { void res.body?.cancel().catch(() => {}); return res; }),
          new Promise<never>((_, reject) => {
            onAbort = () => reject(credentialUnavailable());
            timeoutSignal.addEventListener('abort', onAbort, { once: true });
            if (timeoutSignal.aborted) onAbort();
          }),
        ]);
      } catch {
        await this.pool.query('UPDATE user_provider_credentials SET last_validated_at=NOW(),updated_at=NOW() WHERE owner_id=$1 AND id=$2', [ownerId, id]);
        throw new AppError('PROVIDER_UNAVAILABLE', 'Credential validation is temporarily unavailable', 503);
      } finally { timeoutSignal.removeEventListener('abort', onAbort); }
      const status = response.ok ? 'valid' : response.status === 401 || response.status === 403 ? 'invalid' : row.status;
      // Transient failures preserve validity, but still record the attempted validation.
      const updated = await this.pool.query<CredentialRow>(`UPDATE user_provider_credentials SET status=$3,
        last_validated_at=NOW(),updated_at=NOW() WHERE owner_id=$1 AND id=$2 RETURNING ${metadataColumns}`, [ownerId, id, status]);
      if (!updated.rows[0]) throw new NotFoundError();
      if (!response.ok && response.status !== 401 && response.status !== 403) {
        throw new AppError(response.status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_UNAVAILABLE', 'Credential validation is temporarily unavailable', response.status === 429 ? 429 : 503);
      }
      return metadata(updated.rows[0]);
    });
  }
}

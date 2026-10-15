import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from '../auth/auth-validation.js';

export interface EncryptedCredential {
  ciphertext: string;
  nonce: string;
  auth_tag: string;
  key_version: number;
}

export function credentialUnavailable(): AppError {
  return new AppError('CHAT_CREDENTIAL_UNAVAILABLE', 'Chat credential is unavailable; configure Chat credentials', 503);
}

/** Canonical base64 only: reject Node's permissive decoding of malformed input. */
export function decodeMasterKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) {
    throw new Error('Invalid credential encryption configuration');
  }
  return key;
}

export class CredentialEncryption {
  #key: Buffer;
  constructor(encodedKey: string) { this.#key = decodeMasterKey(encodedKey); }

  encrypt(apiKey: string, ownerId: string, id: string): EncryptedCredential {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify(['chat', ownerId, 'gemini', id, 1])));
    const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
    return { ciphertext: ciphertext.toString('base64'), nonce: nonce.toString('base64'),
      auth_tag: cipher.getAuthTag().toString('base64'), key_version: 1 };
  }

  decrypt(row: EncryptedCredential, ownerId: string, id: string): string {
    try {
      if (row.key_version !== 1) throw new Error();
      const nonce = Buffer.from(row.nonce, 'base64');
      const tag = Buffer.from(row.auth_tag, 'base64');
      if (nonce.length !== 12 || tag.length !== 16) throw new Error();
      const cipher = createDecipheriv('aes-256-gcm', this.#key, nonce);
      cipher.setAAD(Buffer.from(JSON.stringify(['chat', ownerId, 'gemini', id, row.key_version])));
      cipher.setAuthTag(tag);
      const plaintext = Buffer.concat([cipher.update(Buffer.from(row.ciphertext, 'base64')), cipher.final()]);
      try { return plaintext.toString('utf8'); } finally { plaintext.fill(0); }
    } catch { throw credentialUnavailable(); }
  }
}

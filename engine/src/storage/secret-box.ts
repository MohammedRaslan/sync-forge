import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Logger } from '@nestjs/common';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const FORMAT_VERSION = 'v1';

/** Authenticated encryption (AES-256-GCM) for connection credentials at rest. */
export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  /**
   * Uses the key from the environment when given; otherwise loads (or creates on first start)
   * a key file inside the git-ignored part of the workspace.
   */
  static async load(keyFile: string, keyFromEnv?: string): Promise<SecretBox> {
    if (keyFromEnv) return new SecretBox(SecretBox.decodeKey(keyFromEnv, 'SYNCFORGE_SECRET_KEY'));

    try {
      return new SecretBox(SecretBox.decodeKey((await readFile(keyFile, 'utf8')).trim(), keyFile));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const key = randomBytes(KEY_BYTES);
    await writeFile(keyFile, key.toString('base64'), { mode: 0o600, flag: 'wx' });
    new Logger(SecretBox.name).warn(
      `Generated a new encryption key at ${keyFile}. Back it up: saved connections cannot be decrypted without it.`,
    );
    return new SecretBox(key);
  }

  private static decodeKey(encoded: string, origin: string): Buffer {
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(`${origin} must be ${KEY_BYTES} bytes encoded as base64`);
    }
    return key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [FORMAT_VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
  }

  decrypt(payload: string): string {
    const [version, iv, tag, data] = payload.split(':');
    if (version !== FORMAT_VERSION || !iv || !tag || data === undefined) {
      throw new Error('Unrecognized encrypted payload');
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('Could not decrypt saved credentials. Was the encryption key changed?');
    }
  }
}

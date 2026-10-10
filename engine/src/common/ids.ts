import { randomBytes } from 'node:crypto';

/** Readable, file-name-safe ids such as "orders-backfill-3fa1c2". */
export function createId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${slug || 'item'}-${randomBytes(3).toString('hex')}`;
}

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

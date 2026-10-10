import { chunk } from '../common/collections';
import { KeyReader, Row } from '../connectors/connector.types';

/** Keeps each key query well below parameter and query-size limits of every database. */
export const KEYS_PER_QUERY = 200;

/** `findByKeys` for any number of keys, split into queries of at most KEYS_PER_QUERY keys. */
export async function findAllByKeys(reader: KeyReader, collection: string, keyFields: string[], keys: readonly Row[]): Promise<Row[]> {
  const found: Row[] = [];
  for (const part of chunk(keys, KEYS_PER_QUERY)) found.push(...(await reader.findByKeys(collection, keyFields, part)));
  return found;
}

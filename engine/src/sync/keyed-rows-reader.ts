import { chunk } from '../common/collections';
import { getPath } from '../common/paths';
import { keyString } from '../common/values';
import { KeyReader, ReadRequest, Row } from '../connectors/connector.types';
import { KEYS_PER_QUERY } from './key-lookup';
import { SourceKey } from './source-key';
import { RowSource } from './sync-runner';

/** A requested key that matched no source row. `position` is its place in the requested keys, from 1. */
export interface MissingKey {
  position: number;
  key: SourceKey;
}

/**
 * Reads the source rows of given keys instead of a whole collection, so a retry of failed rows goes through the
 * normal run loop. Keys are fetched KEYS_PER_QUERY at a time with `findByKeys` and the rows handed out in batches of
 * the requested size. The request's conditions and watermark are not applied: the rows are asked for by key.
 */
export class KeyedRowsReader implements RowSource {
  constructor(
    private readonly reader: KeyReader,
    private readonly fields: readonly string[],
    private readonly keys: readonly SourceKey[],
    private readonly onMissing: (missing: MissingKey[]) => void,
  ) {}

  async *readBatches(request: ReadRequest): AsyncIterable<Row[]> {
    const fields = [...this.fields];
    const pending: Row[] = [];
    for (const [index, part] of chunk(this.keys, KEYS_PER_QUERY).entries()) {
      // The run loop notices the cancel after the iteration ends.
      if (request.signal?.aborted) return;
      const found = await this.reader.findByKeys(request.collection, fields, [...part]);
      const foundKeys = new Set(found.map((row) => keyString(fields.map((field) => getPath(row, field)))));
      const missing = part.flatMap((key, offset) =>
        foundKeys.has(keyString(fields.map((field) => key[field]))) ? [] : [{ position: index * KEYS_PER_QUERY + offset + 1, key }],
      );
      if (missing.length > 0) this.onMissing(missing);
      pending.push(...found);
      while (pending.length >= request.batchSize) yield pending.splice(0, request.batchSize);
    }
    if (pending.length > 0) yield pending;
  }
}

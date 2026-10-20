import { FileHandle, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream';
import { parse } from 'csv-parse';
import { AppError, NotFoundError, ValidationError } from '../../common/errors';
import { matchesFilters } from '../../common/filters';
import { getPath } from '../../common/paths';
import { keyString } from '../../common/values';
import { CsvConfig } from '../../connections/connection.model';
import { CollectionInfo, Connector, FieldInfo, ReadRequest, Row, SourceScope } from '../connector.types';
import {
  CSV_FULL_MODE_ONLY,
  assertCsvFileName,
  castCell,
  checkHeader,
  csvErrorMessage,
  describeKeyLookup,
  describeRead,
  detectDelimiter,
  isCsvParseError,
  isSafeCsvFileName,
} from './csv-format';

/** Rows sampled to tell which columns hold empty cells. */
const DESCRIBE_SAMPLE = 200;
/** Bytes read to find the header line when the delimiter is detected; a header longer than this is judged on its start. */
const HEADER_PROBE_BYTES = 64 * 1024;

const READ_ONLY = 'CSV connections can only be read for now';

/** A key index of one file: every row under the key string of its key fields. */
type KeyIndex = Map<string, Row[]>;

/**
 * Reads the CSV files uploaded to one connection. Every cell is text (an unquoted empty cell is null);
 * filters run in memory. Read-only: upserts are refused.
 */
export class CsvConnector implements Connector {
  /** Built on the first key lookup per file and key fields; the connector lives for one pipeline, so it never goes stale mid-run. */
  private readonly indexes = new Map<string, Promise<KeyIndex>>();

  constructor(private readonly config: CsvConfig & { directory: string }) {}

  /** The folder can be read. A folder that does not exist yet just means nothing was uploaded. */
  async ping(): Promise<void> {
    await this.fileNames();
  }

  async close(): Promise<void> {
    this.indexes.clear();
  }

  async listCollections(): Promise<CollectionInfo[]> {
    const names = await this.fileNames();
    return names.sort((a, b) => a.localeCompare(b)).map((name) => ({ name, kind: 'file' as const }));
  }

  /** Columns in header order, all text; nullable when the sampled rows hold an empty cell. */
  async describeCollection(collection: string): Promise<FieldInfo[]> {
    let columns: string[] = [];
    const sample: Row[] = [];
    for await (const row of this.rows(collection, { onHeader: (header) => (columns = header) })) {
      sample.push(row);
      if (sample.length >= DESCRIBE_SAMPLE) break;
    }
    return columns.map((path) => ({
      path,
      type: 'string',
      nullable: sample.some((row) => row[path] === null),
      primaryKey: false,
    }));
  }

  async *readBatches(request: ReadRequest): AsyncIterable<Row[]> {
    if (request.watermark) throw new ValidationError(CSV_FULL_MODE_ONLY);
    const filters = request.filters ?? [];
    const limit = request.limit ?? Number.POSITIVE_INFINITY;
    if (limit <= 0) return;
    let batch: Row[] = [];
    let taken = 0;
    for await (const row of this.rows(request.collection)) {
      // Checked per row, not per batch: filters can skip a whole file without filling one.
      if (request.signal?.aborted) return;
      if (!matchesFilters(row, filters)) continue;
      batch.push(row);
      taken += 1;
      const done = taken >= limit;
      if (done || batch.length >= request.batchSize) {
        yield batch;
        batch = [];
      }
      if (done) return;
    }
    if (batch.length > 0) yield batch;
  }

  async count(collection: string, scope: SourceScope = {}): Promise<number> {
    if (scope.query !== undefined) throw new ValidationError('CSV connections read files, not SQL queries');
    const filters = scope.filters ?? [];
    let total = 0;
    // Not cancellable: `Connector.count` takes no signal. Only reconcile counts, outside the run loop.
    for await (const row of this.rows(collection)) {
      if (matchesFilters(row, filters)) total += 1;
    }
    return total;
  }

  explainRead(request: ReadRequest): string {
    return describeRead({ file: request.collection, delimiter: this.config.delimiter, filters: request.filters, limit: request.limit });
  }

  /** Keys compare by `keyString`, so 42 finds the cell "42". */
  async findByKeys(collection: string, keyFields: string[], keys: Row[]): Promise<Row[]> {
    if (keys.length === 0) return [];
    const index = await this.indexFor(collection, keyFields);
    const wanted = new Set(keys.map((key) => keyString(keyFields.map((field) => key[field]))));
    return [...wanted].flatMap((key) => index.get(key) ?? []);
  }

  explainFindByKeys(collection: string, keyFields: string[], keys: Row[]): string {
    return describeKeyLookup(collection, keyFields, keys);
  }

  async upsert(): Promise<void> {
    throw new ValidationError(READ_ONLY);
  }

  explainUpsert(): string {
    throw new ValidationError(READ_ONLY);
  }

  private indexFor(collection: string, keyFields: readonly string[]): Promise<KeyIndex> {
    const cacheKey = JSON.stringify([collection, keyFields]);
    let index = this.indexes.get(cacheKey);
    if (!index) {
      index = this.buildIndex(collection, keyFields);
      // A failed build is not kept, so a later call reads the file again instead of repeating the failure.
      index.catch(() => this.indexes.delete(cacheKey));
      this.indexes.set(cacheKey, index);
    }
    return index;
  }

  private async buildIndex(collection: string, keyFields: readonly string[]): Promise<KeyIndex> {
    const index: KeyIndex = new Map();
    // Not cancellable: `findByKeys` takes no signal. A run notices a cancel at its next check after the lookup.
    for await (const row of this.rows(collection)) {
      const key = keyString(keyFields.map((field) => getPath(row, field)));
      const rows = index.get(key);
      if (rows) rows.push(row);
      else index.set(key, [row]);
    }
    return index;
  }

  /** Names of the uploaded files. Temporary uploads start with a dot, so the file name rule leaves them out. */
  private async fileNames(): Promise<string[]> {
    try {
      const entries = await readdir(this.config.directory, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile() && isSafeCsvFileName(entry.name)).map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  /** Every row of a file, parsed as it streams. Shared by reads, counts, describe and the key index. */
  private async *rows(file: string, options: { onHeader?: (columns: string[]) => void } = {}): AsyncGenerator<Row> {
    const handle = await this.openFile(file);
    let streaming = false;
    try {
      const delimiter = this.config.delimiter === 'auto' ? detectDelimiter(await headerLine(handle)) : this.config.delimiter;
      const parser = parse({
        bom: true,
        delimiter,
        columns: (header: (string | null)[]) => {
          const columns = checkHeader(header, file);
          options.onHeader?.(columns);
          return columns;
        },
        cast: castCell,
        relax_column_count: false,
        // A blank line is no row: otherwise a trailing one is a ragged row, or a null row in a one-column file.
        skip_empty_lines: true,
      });
      const input = handle.createReadStream({ start: 0 });
      streaming = true;
      // Errors from either stream reach the loop below through the parser, and leaving the loop early
      // destroys both streams (closing the file); the callback has nothing left to do.
      pipeline(input, parser, () => undefined);
      for await (const record of parser) yield record as Row;
    } catch (error) {
      throw readFailure(error, file);
    } finally {
      // Once streaming, the stream owns the handle and closes it. Cleanup only.
      if (!streaming) await handle.close().catch(() => undefined);
    }
  }

  private async openFile(file: string): Promise<FileHandle> {
    assertCsvFileName(file);
    try {
      return await open(join(this.config.directory, file), 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError(`"${file}" is not uploaded to this connection`);
      throw error;
    }
  }
}

/** The first line of a file, read without moving the handle's position. Also used to check an upload's header. */
export async function headerLine(handle: FileHandle): Promise<string> {
  const buffer = Buffer.alloc(HEADER_PROBE_BYTES);
  const { bytesRead } = await handle.read(buffer, 0, HEADER_PROBE_BYTES, 0);
  const text = buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '');
  return text.split(/\r?\n/, 1)[0];
}

/** Parse errors become a user-facing message without cell text; refused headers and I/O errors pass through. */
function readFailure(error: unknown, file: string): unknown {
  if (error instanceof AppError || !isCsvParseError(error)) return error;
  return new ValidationError(csvErrorMessage(error, file));
}

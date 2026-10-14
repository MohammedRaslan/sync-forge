import { randomBytes } from 'node:crypto';
import { Stats, createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Injectable } from '@nestjs/common';
import { parse } from 'csv-parse';
import { NotFoundError, ValidationError } from '../common/errors';
import { CsvDelimiter, assertCsvFileName, checkHeader, csvErrorMessage, detectDelimiter, isCsvParseError, isSafeCsvFileName } from '../connectors/csv/csv-format';
import { headerLine } from '../connectors/csv/csv.connector';
import { SettingsService } from '../settings/settings.service';
import { Workspace } from '../storage/workspace';
import { CsvFileInfo } from './connection.model';

const BYTES_PER_MB = 1024 * 1024;

/** How an upload is read: the connection's delimiter setting and the length the client declared, if any. */
export interface CsvUploadOptions {
  delimiter: CsvDelimiter;
  declaredLength?: number;
}

/**
 * The files of each CSV connection: one folder per connection under the workspace's local state.
 * Uploads are written to a temporary file and renamed into place, so a reader never sees half a file
 * and a failed upload leaves the previous file untouched.
 */
@Injectable()
export class CsvFileStore {
  constructor(
    private readonly workspace: Workspace,
    private readonly settings: SettingsService,
  ) {}

  /** The folder holding a connection's uploaded files. It may not exist until the first upload. */
  directoryFor(connectionId: string): string {
    return this.workspace.local('uploads', connectionId);
  }

  /** The largest upload accepted, read from the settings each time so a change applies without a restart. */
  async maxBytes(): Promise<number> {
    return (await this.settings.get()).csvMaxUploadMb * BYTES_PER_MB;
  }

  /** The uploaded files, by name. Temporary uploads start with a dot, so the file name rule leaves them out. */
  async list(connectionId: string): Promise<CsvFileInfo[]> {
    const directory = this.directoryFor(connectionId);
    let names: string[];
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      names = entries.filter((entry) => entry.isFile() && isSafeCsvFileName(entry.name)).map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    names.sort((a, b) => a.localeCompare(b));
    return Promise.all(names.map(async (name) => fileInfo(name, await stat(join(directory, name)))));
  }

  /**
   * Saves `body` as `name`, replacing a file of that name. Refuses a body over the size limit (declared or
   * streamed), one that is not UTF-8 text, and a file whose header row is missing or unusable; either way
   * the previous file is kept.
   */
  async save(connectionId: string, name: string, body: Readable, options: CsvUploadOptions): Promise<CsvFileInfo> {
    assertCsvFileName(name);
    const { csvMaxUploadMb } = await this.settings.get();
    const maxBytes = csvMaxUploadMb * BYTES_PER_MB;
    if (options.declaredLength !== undefined && options.declaredLength > maxBytes) throw tooLarge(csvMaxUploadMb);

    const directory = this.directoryFor(connectionId);
    // Owner-only, like the rest of the local state: uploads are customer data.
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, name);
    const part = join(directory, `.${name}.${randomBytes(8).toString('hex')}.part`);
    try {
      // The declared length can be missing (chunked uploads), so the bytes are counted as they arrive too.
      // Checked while streaming: decoding a non-UTF-8 file later would silently turn its characters into U+FFFD.
      const upload = checkedUpload([byteLimit(maxBytes, csvMaxUploadMb), utf8Text(name)]);
      await pipeline(body, upload.stream, createWriteStream(part, { flags: 'wx', mode: 0o600 }));
      const refusal = upload.refusal();
      if (refusal) throw refusal;
      await checkUploadedHeader(part, name, options.delimiter);
      await rename(part, target);
    } catch (error) {
      // Cleanup only: the part file may never have been created, and the original error is what the caller needs.
      await unlink(part).catch(() => undefined);
      throw error;
    }
    return fileInfo(name, await stat(target));
  }

  async remove(connectionId: string, name: string): Promise<void> {
    assertCsvFileName(name);
    try {
      await unlink(join(this.directoryFor(connectionId), name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError(`"${name}" is not uploaded to this connection`);
      throw error;
    }
  }

  /** Deletes the connection's folder with every file in it; nothing to do when nothing was uploaded. */
  async removeAll(connectionId: string): Promise<void> {
    await rm(this.directoryFor(connectionId), { recursive: true, force: true });
  }
}

function fileInfo(name: string, stats: Stats): CsvFileInfo {
  return { name, size: stats.size, modifiedAt: stats.mtime.toISOString() };
}

function tooLarge(limitMb: number): ValidationError {
  return new ValidationError(`File is larger than the ${limitMb} MB limit set in Settings`);
}

function notUtf8(name: string): ValidationError {
  return new ValidationError(`"${name}" is not UTF-8 text. Save it as "CSV UTF-8" and upload it again.`);
}

/** One check on the bytes of an upload: `chunk` sees each chunk in order, `end` runs once all arrived. Each returns its refusal, if any. */
interface UploadCheck {
  chunk(chunk: Buffer): ValidationError | undefined;
  end(): ValidationError | undefined;
}

/**
 * Passes an upload through `checks`. After the first refusal it drops the remaining bytes instead of failing
 * the stream: failing would destroy the request, and the client would see a reset connection instead of the
 * 400 that says why. Read `refusal()` once the pipeline has finished.
 */
function checkedUpload(checks: readonly UploadCheck[]): { stream: Transform; refusal: () => ValidationError | undefined } {
  let refusal: ValidationError | undefined;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      refusal ??= firstRefusal(checks, (check) => check.chunk(chunk));
      if (refusal) callback();
      else callback(null, chunk);
    },
    flush(callback) {
      refusal ??= firstRefusal(checks, (check) => check.end());
      callback();
    },
  });
  return { stream, refusal: () => refusal };
}

function firstRefusal(checks: readonly UploadCheck[], run: (check: UploadCheck) => ValidationError | undefined): ValidationError | undefined {
  for (const check of checks) {
    const refusal = run(check);
    if (refusal) return refusal;
  }
  return undefined;
}

/** Refuses once more than `maxBytes` went by. */
function byteLimit(maxBytes: number, limitMb: number): UploadCheck {
  let seen = 0;
  return {
    chunk(chunk) {
      seen += chunk.length;
      return seen > maxBytes ? tooLarge(limitMb) : undefined;
    },
    end: () => undefined,
  };
}

/** Refuses bytes that are not UTF-8, including a character cut off at the end. A byte order mark is fine. */
function utf8Text(name: string): UploadCheck {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  // `stream: true` keeps a character split between two chunks for the next one; the final call checks nothing is left over.
  return {
    chunk: (chunk) => refusedUnlessDecoded(() => decoder.decode(chunk, { stream: true }), name),
    end: () => refusedUnlessDecoded(() => decoder.decode(), name),
  };
}

function refusedUnlessDecoded(decode: () => string, name: string): ValidationError | undefined {
  try {
    decode();
    return undefined;
  } catch (error) {
    // A fatal TextDecoder throws a TypeError for bytes that are not UTF-8.
    if (error instanceof TypeError) return notUtf8(name);
    throw error;
  }
}

/**
 * Parses only the header row of an uploaded file, the way the connector will read it, so a file that
 * could never be read is refused at upload. Messages name the file and columns, never cell values.
 */
async function checkUploadedHeader(path: string, name: string, delimiter: CsvDelimiter): Promise<void> {
  const separator = delimiter === 'auto' ? detectDelimiter(await firstLine(path)) : delimiter;
  let header: string[] | undefined;
  const parser = parse({
    bom: true,
    delimiter: separator,
    to_line: 1,
    skip_empty_lines: true,
    columns: (columns: (string | null)[]) => (header = checkHeader(columns, name)),
  });
  const input = createReadStream(path);
  try {
    // Not `pipeline`: the parser ends after the header row while the file still has bytes, which `pipeline` reports as a failure.
    await new Promise<void>((resolve, reject) => {
      input.on('error', reject);
      parser.on('error', reject);
      parser.on('end', resolve);
      // Nothing reads the parser's output: the header row is all this needs.
      parser.resume();
      input.pipe(parser);
    });
  } catch (error) {
    if (isCsvParseError(error)) throw new ValidationError(csvErrorMessage(error, name));
    throw error;
  } finally {
    input.destroy();
  }
  if (header === undefined) throw new ValidationError(`${name} is empty: its first row must name the columns`);
}

async function firstLine(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    return await headerLine(handle);
  } finally {
    // Cleanup only: a failed close must not hide the result or the read error.
    await handle.close().catch(() => undefined);
  }
}

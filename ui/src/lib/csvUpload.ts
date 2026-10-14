import { api } from '../api/client';
import type { CsvFileInfo } from '../api/types';

/** Same rule as the engine's file store: a plain name ending in .csv that is not a device name Windows reserves, so it is safe as a file on disk. */
const CSV_FILE_NAME = /^(?!(?:con|prn|aux|nul|com\d|lpt\d)\.csv$)[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}\.csv$/i;

const BYTES_PER_MB = 1024 * 1024;

/** Why an upload was refused before it was sent. `size` means the limit, which is changed in Settings. */
export class CsvUploadRefused extends Error {
  constructor(
    message: string,
    readonly reason: 'name' | 'size',
  ) {
    super(message);
    this.name = 'CsvUploadRefused';
  }
}

/** The upload limit in whole megabytes, as it is set in Settings. */
export function maxUploadMb(maxBytes: number): number {
  return Math.round(maxBytes / BYTES_PER_MB);
}

/** The reason `file` cannot be uploaded as `name`, or undefined when it can. */
export function csvUploadProblem(file: File, name: string, maxBytes: number): CsvUploadRefused | undefined {
  if (!CSV_FILE_NAME.test(name)) {
    return new CsvUploadRefused(
      `“${name}” can't be uploaded under that name. Use a name ending in .csv that starts with a letter or digit ` +
        'and has only letters, digits, spaces, dots, dashes and underscores, and isn\'t a name Windows reserves such as con.csv ' +
        '(rename the file and try again).',
      'name',
    );
  }
  if (file.size > maxBytes) {
    return new CsvUploadRefused(`“${name}” is too large. Files up to ${maxUploadMb(maxBytes)} MB`, 'size');
  }
  return undefined;
}

/** Checks the file the way the engine will, then uploads it. Creates the file, or replaces one with the same name. */
export function uploadCsvFile(
  connectionId: string,
  file: File,
  name: string,
  maxBytes: number,
  onProgress?: (fraction: number) => void,
): Promise<CsvFileInfo> {
  const problem = csvUploadProblem(file, name, maxBytes);
  if (problem) return Promise.reject(problem);
  return api.connections.uploadFile(connectionId, file, name, onProgress);
}

/**
 * Uploads `file` under its own name, checked against the limit set now (read per upload, so a change
 * in Settings applies at once). Resolves to the saved file name.
 */
export async function uploadCsvFileAsNamed(
  connectionId: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const { maxBytes } = await api.connections.files(connectionId);
  const saved = await uploadCsvFile(connectionId, file, file.name, maxBytes, onProgress);
  return saved.name;
}

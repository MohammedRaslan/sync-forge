/**
 * Pure helpers for CSV sources: delimiter detection, file names, cell values, header checks,
 * the Query tab text and safe parse-error messages. The CSV connector does the I/O.
 */
import { AppError, ValidationError, errorMessage } from '../../common/errors';
import { isSafeFieldPath } from '../../common/paths';
import { FilterOp, Row, SourceFilter } from '../connector.types';

/** Why CSV sources have no incremental mode; shown when a job asks for one. */
export const CSV_FULL_MODE_ONLY = 'CSV sources run in full mode: each upload replaces the file, and upserts make re-running it safe';

/** A delimiter Syncforge reads. */
export type CsvSeparator = ',' | ';' | '\t';

/** A connection's delimiter setting: one of the separators, or detected from the header line. */
export type CsvDelimiter = CsvSeparator | 'auto';

/** Tried in this order, so a tie goes to the comma. */
const SEPARATORS: readonly CsvSeparator[] = [',', ';', '\t'];

/**
 * The separator used most often in a header line, counting only characters outside double quotes.
 * Falls back to a comma when the line holds none (a single-column file).
 */
export function detectDelimiter(headerLine: string): CsvSeparator {
  const counts = new Map<string, number>();
  let quoted = false;
  for (const char of headerLine) {
    // A doubled quote inside a quoted value toggles twice, so it leaves the state unchanged.
    if (char === '"') quoted = !quoted;
    else if (!quoted) counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let best: CsvSeparator = ',';
  for (const separator of SEPARATORS) {
    if ((counts.get(separator) ?? 0) > (counts.get(best) ?? 0)) best = separator;
  }
  return best;
}

/**
 * Names an uploaded CSV file may have: no folders, no leading dot (temporary uploads start with one),
 * at most 100 characters before ".csv", and not a device name Windows reserves (`con.csv` cannot be
 * created there, so a workspace holding one could not be copied to Windows).
 */
export const CSV_FILE_NAME = /^(?!(?:con|prn|aux|nul|com\d|lpt\d)\.csv$)[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}\.csv$/i;

/** True when `name` matches {@link CSV_FILE_NAME}, so it can be joined to the connection's folder. */
export function isSafeCsvFileName(name: string): boolean {
  return CSV_FILE_NAME.test(name);
}

/** Refuses a name that does not match {@link CSV_FILE_NAME}, with a message that says what is allowed. */
export function assertCsvFileName(name: string): void {
  if (!isSafeCsvFileName(name)) {
    throw new ValidationError(
      `"${name}" is not a CSV file name: start with a letter or digit, use letters, digits, spaces, ".", "_" or "-", end in .csv, ` +
        'at most 100 characters before it, and not a name Windows reserves (con, prn, aux, nul, com1-9, lpt1-9)',
    );
  }
}

/**
 * csv-parse `cast` callback. Every cell stays text, except an unquoted empty cell, which is null.
 * A quoted `""` stays an empty string, like Postgres `COPY ... CSV`.
 */
export function castCell(value: string, context: { readonly quoting: boolean }): string | null {
  return value === '' && !context.quoting ? null : value;
}

/**
 * csv-parse `columns` callback: the header row as field names. Refuses names that are empty,
 * repeated, or not usable as a field path (such as `__proto__`).
 */
export function checkHeader(columns: readonly (string | null)[], file: string): string[] {
  const seen = new Set<string>();
  return columns.map((column, index) => {
    if (column === null || column.trim() === '') {
      throw new ValidationError(`${file}: column ${index + 1} of the header row has no name`);
    }
    if (!isSafeFieldPath(column)) {
      throw new ValidationError(`${file}: column "${column}" in the header row is not a usable field name`);
    }
    if (seen.has(column)) {
      throw new ValidationError(`${file}: column "${column}" appears twice in the header row`);
    }
    seen.add(column);
    return column;
  });
}

const OP_SYMBOLS: Record<FilterOp, string> = { eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };

/** What a CSV read does, for the Query tab. */
export interface CsvReadDescription {
  file: string;
  delimiter: CsvDelimiter;
  filters?: readonly SourceFilter[];
  limit?: number;
}

/** A CSV read in words, e.g. `Read "a.csv" (delimiter ",", header row) keeping rows where amount > 10, first 10 rows`. */
export function describeRead(read: CsvReadDescription): string {
  let text = `Read ${JSON.stringify(read.file)} (${delimiterLabel(read.delimiter)}, header row)`;
  const filters = read.filters ?? [];
  if (filters.length > 0) text += ` keeping rows where ${filters.map(describeFilter).join(' and ')}`;
  if (read.limit !== undefined) text += `, first ${read.limit} ${read.limit === 1 ? 'row' : 'rows'}`;
  return text;
}

/** A key lookup in a CSV file in words: the file is indexed once per run, then each key is matched. */
export function describeKeyLookup(file: string, keyFields: readonly string[], keys: readonly Row[]): string {
  const shown = keys.map((key) => {
    const values = keyFields.map((field) => formatValue(key[field]));
    return values.length === 1 ? values[0] : `(${values.join(', ')})`;
  });
  const count = `${keys.length} ${keys.length === 1 ? 'key' : 'keys'}`;
  return `Index ${JSON.stringify(file)} by ${keyFields.join(', ')} (once per run), then match ${count}${shown.length > 0 ? `: ${shown.join(', ')}` : ''}`;
}

function delimiterLabel(delimiter: CsvDelimiter): string {
  if (delimiter === 'auto') return 'delimiter detected from the header row';
  return delimiter === '\t' ? 'delimiter tab' : `delimiter ${JSON.stringify(delimiter)}`;
}

function describeFilter(filter: SourceFilter): string {
  const condition = `${filter.field} ${OP_SYMBOLS[filter.op]} ${formatValue(filter.value)}`;
  return filter.op === 'ne' ? `(${filter.field} is empty or ${condition})` : condition;
}

function formatValue(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

/** The parts of a csv-parse `CsvError` this module reads. Duck-typed: each csv-parse entry point bundles its own class. */
export interface CsvParseError {
  code: string;
  lines: number;
  columns?: unknown;
  record?: unknown;
}

/** True for an error raised by csv-parse itself (bad quoting, ragged rows), as opposed to I/O or a refused header. */
export function isCsvParseError(error: unknown): error is CsvParseError {
  if (!(error instanceof Error)) return false;
  const { code, lines } = error as Partial<CsvParseError>;
  return typeof code === 'string' && code.startsWith('CSV_') && typeof lines === 'number';
}

/**
 * A message for an error raised while parsing `file`, e.g. `customers.csv line 42: expected 5 columns, got 4`.
 * Built only from csv-parse's error code and counts: its own messages can quote cell text.
 * Errors that are not parse errors (a refused header, I/O) keep their message.
 */
export function csvErrorMessage(error: unknown, file: string): string {
  if (error instanceof AppError || !isCsvParseError(error)) return errorMessage(error);
  return `${file} line ${error.lines}: ${parseProblem(error)}`;
}

function parseProblem(error: CsvParseError): string {
  switch (error.code) {
    case 'CSV_RECORD_INCONSISTENT_COLUMNS': {
      const expected = Array.isArray(error.columns) ? error.columns.length : undefined;
      const got = Array.isArray(error.record) ? error.record.length : undefined;
      return expected !== undefined && got !== undefined
        ? `expected ${expected} columns, got ${got}`
        : 'the row does not have as many columns as the header';
    }
    case 'CSV_RECORD_INCONSISTENT_FIELDS_LENGTH':
      return 'the row does not have as many columns as the rows before it';
    case 'CSV_QUOTE_NOT_CLOSED':
      return 'a quoted value is never closed';
    case 'CSV_INVALID_CLOSING_QUOTE':
    case 'CSV_NON_TRIMABLE_CHAR_AFTER_CLOSING_QUOTE':
      return 'unexpected text after a closing quote (quotes inside a quoted value must be doubled)';
    case 'CSV_MAX_RECORD_SIZE':
      return 'the row is too large';
    default:
      return `the file cannot be read as CSV (${error.code})`;
  }
}

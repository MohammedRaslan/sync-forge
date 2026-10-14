/**
 * Value normalization. Database drivers return their own types (BSON ObjectId,
 * Decimal128, Buffer, bigint...). Before data crosses into a different database,
 * or into JSON, it is turned into portable JavaScript values.
 */

interface BsonValue {
  _bsontype: string;
  toHexString?: () => string;
  toString(): string;
  valueOf(): unknown;
}

function isBsonValue(value: object): value is BsonValue {
  return typeof (value as { _bsontype?: unknown })._bsontype === 'string';
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function normalizeValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (isBsonValue(value)) return normalizeBson(value);

  const result: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) result[key] = normalizeValue(inner);
  return result;
}

function normalizeBson(value: BsonValue): unknown {
  switch (value._bsontype) {
    case 'ObjectId':
    case 'ObjectID':
      return value.toHexString ? value.toHexString() : value.toString();
    case 'Int32':
    case 'Double':
      return Number(value.valueOf());
    case 'Long': {
      const asString = value.toString();
      const asNumber = Number(asString);
      return Number.isSafeInteger(asNumber) ? asNumber : asString;
    }
    default:
      // Decimal128, UUID and friends: the string form is lossless.
      return value.toString();
  }
}

export function normalizeRecord(row: Record<string, unknown>): Record<string, unknown> {
  return normalizeValue(row) as Record<string, unknown>;
}

/** JSON with sorted keys, so structurally equal objects compare equal as strings. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(normalizeValue(value)));
}

function sortKeys(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

function parseIfJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function toTime(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return parseDateText(value);
  if (typeof value === 'number') return value;
  return Number.NaN;
}

/**
 * A plain decimal as databases print it: optional minus, no leading zeros, no exponent, no spaces.
 * Anything else (e.g. "00123", "1e3", " 12") is treated as text, so codes stay distinct.
 */
const CANONICAL_DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** "12.50" → "12.5", "-0.0" → "0": exact, so long decimals are not rounded through a double. */
function trimDecimal(text: string): string {
  const trimmed = text.includes('.') ? text.replace(/\.?0+$/, '') : text;
  return trimmed === '-0' ? '0' : trimmed;
}

/** Boolean words as databases and CSV files write them (Postgres text output is "t"/"f"). */
const BOOLEAN_WORDS: Readonly<Record<string, boolean>> = { t: true, true: true, '1': true, f: false, false: false, '0': false };

function booleansEqual(flag: boolean, other: unknown): boolean {
  if (typeof other === 'boolean') return flag === other;
  return typeof other === 'string' && BOOLEAN_WORDS[other.toLowerCase()] === flag;
}

function textsEqual(a: string, b: string): boolean {
  if (CANONICAL_DECIMAL.test(a) && CANONICAL_DECIMAL.test(b)) return trimDecimal(a) === trimDecimal(b);
  return a === b;
}

/**
 * Compares a value we expect to have written with the value read back from a SQL target, where the database
 * converts bound text to the column's type, so a different spelling of the same value is not a change.
 * Tolerates representation differences that are not data differences:
 * - null vs missing;
 * - Date vs date text or epoch milliseconds (Cosmos DB, CSV); text without an offset means UTC, as in `parseDateText`;
 * - number vs numeric text (Postgres NUMERIC, bigint);
 * - two plain decimal texts by value ("12.5" = "12.50", "-3" = "-3.0"); "00123", "1e3" or " 12" stay text,
 *   so codes with leading zeros never match their number;
 * - boolean vs "t"/"true"/"1" or "f"/"false"/"0" (any case); text vs text is not read as boolean;
 * - JSON text vs parsed objects (jsonb).
 *
 * The decimal rule has a price: version-like texts in a text column read as numbers, so "1.10" = "1.1" and a
 * run that rewrites one as the other is reported as unchanged. Document targets use `documentValuesEqual`.
 */
export function valuesEqual(expected: unknown, actual: unknown): boolean {
  const a = normalizeValue(expected);
  const b = normalizeValue(actual);

  if (a === null || b === null) return a === b;
  if (a instanceof Date || b instanceof Date) {
    const [timeA, timeB] = [toTime(a), toTime(b)];
    return !Number.isNaN(timeA) && timeA === timeB;
  }
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  if (typeof a === 'boolean') return booleansEqual(a, b);
  if (typeof b === 'boolean') return booleansEqual(b, a);
  if (typeof a === 'object' || typeof b === 'object') {
    return stableStringify(parseIfJson(a)) === stableStringify(parseIfJson(b));
  }
  return textsEqual(String(a), String(b));
}

/**
 * Like `valuesEqual`, for targets that store each value with its own type (MongoDB, Cosmos DB), where a query
 * for 1 never matches "1". A change of type between text, number and boolean is a difference, because the run
 * would write it: "1" over true replaces the boolean. Texts compare exactly, and JSON text is not an object.
 * Tolerated: null vs missing; driver types (Int32, Long, Decimal128) after `normalizeValue`; a Date read back as
 * the ISO text Cosmos DB stores it as. Inside objects and arrays, dates compare by their ISO text.
 */
export function documentValuesEqual(expected: unknown, actual: unknown): boolean {
  const a = normalizeValue(expected);
  const b = normalizeValue(actual);

  if (a === null || b === null) return a === b;
  if (a instanceof Date) return b instanceof Date ? a.getTime() === b.getTime() : b === a.toISOString();
  // Text or a number written over a date replaces it.
  if (b instanceof Date) return false;
  if (typeof a === 'object' && typeof b === 'object') return stableStringify(a) === stableStringify(b);
  return a === b;
}

/**
 * Identity of a row by its key values, insensitive to driver representation:
 * 1 and "1" (Postgres bigint), ObjectId and its hex string, Date and its ISO string are the same key.
 * Beyond that a key keeps its exact text, unlike `valuesEqual`: "12.5" and "12.50", or true and "t", are
 * different keys, because databases match keys on exact values. A key spelled differently in source and
 * target therefore shows up as a missing row, not as a match.
 */
export function keyString(values: readonly unknown[]): string {
  return JSON.stringify(
    values.map((value) => {
      const normalized = normalizeValue(value);
      if (normalized instanceof Date) return normalized.toISOString();
      if (normalized !== null && typeof normalized === 'object') return stableStringify(normalized);
      return normalized === null ? null : String(normalized);
    }),
  );
}

/**
 * A date-time with a time of day but no offset, e.g. 2025-01-31T08:00, 2025-01-31T08:00:00.5,
 * or 2025-01-31 08:00:00 as SQL databases write it.
 */
const DATE_TIME_WITHOUT_OFFSET = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(:\d{2}(\.\d+)?)?)$/;

/**
 * Milliseconds since the epoch for a date written as text, or NaN when it is not one.
 * A date-time without an offset means UTC, so a job spec or a CSV file reads the same on every machine.
 * A date alone (2025-01-31) is UTC midnight.
 */
export function parseDateText(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return Number.NaN;
  const withoutOffset = DATE_TIME_WITHOUT_OFFSET.exec(trimmed);
  return Date.parse(withoutOffset ? `${withoutOffset[1]}T${withoutOffset[2]}Z` : trimmed);
}

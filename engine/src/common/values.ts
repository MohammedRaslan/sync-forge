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
  if (typeof value === 'string' || typeof value === 'number') return new Date(value).getTime();
  return Number.NaN;
}

/**
 * Compares a value we expect to have written with the value read back from the target.
 * Tolerates representation differences that are not data differences:
 * numeric strings vs numbers (Postgres NUMERIC), Date vs ISO string (Cosmos DB),
 * JSON text vs parsed objects (jsonb), and null vs missing.
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
  if (typeof a === 'boolean' || typeof b === 'boolean') return String(a) === String(b);
  if (typeof a === 'object' || typeof b === 'object') {
    return stableStringify(parseIfJson(a)) === stableStringify(parseIfJson(b));
  }
  return String(a) === String(b);
}

/**
 * Identity of a row by its key values, insensitive to representation:
 * 1 and "1" (Postgres bigint), ObjectId and its hex string, Date and its ISO string are the same key.
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

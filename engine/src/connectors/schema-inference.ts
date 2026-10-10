import { FieldInfo, Row } from './connector.types';
import { isPlainObject } from '../common/values';

const MAX_DEPTH = 4;

/**
 * Infers a field list from sampled documents, for schemaless stores.
 * Nested objects are listed both as a whole ("address") and by their fields
 * ("address.city"), so users can map either.
 */
export function inferSchema(documents: readonly Row[], keyFields: readonly string[]): FieldInfo[] {
  const stats = new Map<string, { types: Set<string>; seenIn: number }>();

  for (const document of documents) {
    const seenInDocument = new Set<string>();
    walk(document, '', 0, (path, type) => {
      const entry = stats.get(path) ?? { types: new Set<string>(), seenIn: 0 };
      entry.types.add(type);
      if (!seenInDocument.has(path)) {
        entry.seenIn += 1;
        seenInDocument.add(path);
      }
      stats.set(path, entry);
    });
  }

  const total = documents.length;
  return [...stats.entries()]
    .map(([path, { types, seenIn }]) => {
      const concrete = [...types].filter((type) => type !== 'null').sort();
      return {
        path,
        type: concrete.length > 0 ? concrete.join(' | ') : 'null',
        nullable: types.has('null') || seenIn < total,
        primaryKey: keyFields.includes(path),
        presence: total === 0 ? 0 : seenIn / total,
      };
    })
    .sort((a, b) => Number(b.primaryKey) - Number(a.primaryKey) || a.path.localeCompare(b.path));
}

function walk(value: Row, prefix: string, depth: number, visit: (path: string, type: string) => void): void {
  for (const [key, inner] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const type = describeType(inner);
    visit(path, type);
    if (type === 'object' && depth < MAX_DEPTH) walk(inner as Row, path, depth + 1, visit);
  }
}

export function describeType(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  if (Buffer.isBuffer(value)) return 'binary';
  if (typeof value === 'object') {
    const bsonType = (value as { _bsontype?: string })._bsontype;
    if (bsonType) return bsonType === 'ObjectID' ? 'objectId' : bsonType.charAt(0).toLowerCase() + bsonType.slice(1);
    return isPlainObject(value) ? 'object' : 'unknown';
  }
  return typeof value;
}

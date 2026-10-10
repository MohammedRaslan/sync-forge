/**
 * Watermarks make incremental runs possible: after each batch we remember the
 * watermark value of the last row read (rows are read in watermark order), and the
 * next run reads rows whose watermark is >= that value.
 *
 * ">=" rather than ">" is deliberate: several rows can share one watermark value
 * (e.g. same updated_at). Re-reading the boundary rows is harmless because every
 * write is an idempotent upsert, while skipping them would silently lose data.
 */

export type StoredWatermark =
  | { type: 'date'; value: string }
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'objectId'; value: string };

export function toStoredWatermark(value: unknown): StoredWatermark | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : { type: 'date', value: value.toISOString() };
  }
  if (typeof value === 'number') return Number.isFinite(value) ? { type: 'number', value } : null;
  if (typeof value === 'bigint') return { type: 'string', value: value.toString() };
  if (typeof value === 'string') return { type: 'string', value };
  if (typeof value === 'object') {
    const bson = value as { _bsontype?: string; toHexString?: () => string; valueOf(): unknown };
    if ((bson._bsontype === 'ObjectId' || bson._bsontype === 'ObjectID') && bson.toHexString) {
      return { type: 'objectId', value: bson.toHexString() };
    }
    if (bson._bsontype === 'Int32' || bson._bsontype === 'Double' || bson._bsontype === 'Long') {
      return toStoredWatermark(Number(bson.valueOf()));
    }
  }
  return null;
}

/** Plain JS value for a stored watermark. Connectors with native types (ObjectId) convert further. */
export function fromStoredWatermark(watermark: StoredWatermark): unknown {
  return watermark.type === 'date' ? new Date(watermark.value) : watermark.value;
}

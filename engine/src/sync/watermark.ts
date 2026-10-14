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
  | {
      type: 'date';
      value: string;
      /**
       * Saved by an engine that reads Postgres `timestamp`/`date` columns as UTC. Older engines read them in the
       * machine's local time and saved that moment, so an unmarked value can be off by the machine's UTC offset.
       * Optional, so watermarks saved before keep loading.
       */
      utc?: true;
    }
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'objectId'; value: string };

export function toStoredWatermark(value: unknown): StoredWatermark | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : { type: 'date', value: value.toISOString(), utc: true };
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

/**
 * How far back an unmarked date watermark resumes: the largest UTC offset (UTC+14), which also covers every
 * offset west of UTC (down to UTC-12), where an old watermark is ahead of the rows it was read from.
 * Re-reading the extra rows once is harmless (inclusive watermark, idempotent upserts); skipping them is not.
 */
export const LEGACY_DATE_WATERMARK_SHIFT_HOURS = 14;
const LEGACY_DATE_WATERMARK_SHIFT_MS = LEGACY_DATE_WATERMARK_SHIFT_HOURS * 60 * 60 * 1000;

/**
 * The watermark a run starts from. A date watermark saved by an older engine (no `utc` marker) is moved back
 * by the largest UTC offset and marked, so saving it again never moves it twice. Anything else is returned as is.
 */
export function upgradedWatermark(watermark: StoredWatermark): StoredWatermark {
  if (watermark.type !== 'date' || watermark.utc) return watermark;
  const time = Date.parse(watermark.value);
  if (Number.isNaN(time)) return watermark;
  return { type: 'date', value: new Date(time - LEGACY_DATE_WATERMARK_SHIFT_MS).toISOString(), utc: true };
}

/** Plain JS value for a stored watermark. Connectors with native types (ObjectId) convert further. */
export function fromStoredWatermark(watermark: StoredWatermark): unknown {
  const current = upgradedWatermark(watermark);
  return current.type === 'date' ? new Date(current.value) : current.value;
}

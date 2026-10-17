import { getPath } from '../common/paths';
import { normalizeValue } from '../common/values';
import { Row } from '../connectors/connector.types';
import { Job } from '../jobs/job.model';
import { TransformName } from '../transforms/transform.registry';

/**
 * The raw source values that identify a source row, by source field (e.g. `{ "customer_id": 42 }`).
 * Kept with a failed row so a retry can fetch that row from the source again.
 */
export type SourceKey = Record<string, string | number>;

/** The source fields a job's rows can be fetched by, or why they cannot be. */
export type SourceKeyFields = { fields: string[] } | { reason: string };

/**
 * Transforms that keep a key from being traced back to one source value. Any other transform reads only its
 * source field, so the raw value of that field finds the row again, whatever the transform made of it.
 * A default is excluded because it turns an empty source value, which no key lookup can find, into a key.
 */
const UNTRACEABLE: Readonly<Partial<Record<TransformName, string>>> = {
  expression: 'an expression',
  constant: 'a constant',
  default: 'a default value',
};

/**
 * The source fields behind a job's target key: for each key field, the source field its mapping copies.
 * Not derivable for SQL query sources, for keys set by an expression, a constant or a default, and for keys
 * taken from a lookup; the reason says which, so people can change the job.
 */
export function sourceKeyFields(job: Pick<Job, 'source' | 'target' | 'mappings' | 'lookups'>): SourceKeyFields {
  if (job.source.query !== undefined) return { reason: "rows of a SQL query source can't be fetched by key" };
  const lookupNames = (job.lookups ?? []).map((lookup) => lookup.as);
  const fields: string[] = [];
  for (const key of job.target.keyFields) {
    const mapping = job.mappings.find((candidate) => candidate.to === key);
    const untraceable = mapping && UNTRACEABLE[mapping.transform];
    if (untraceable) return { reason: `key field "${key}" is set by ${untraceable}; map it from a source field to re-run failed rows` };
    const from = mapping?.from;
    if (!from) return { reason: `key field "${key}" is not mapped from a source field` };
    const lookup = lookupNames.find((name) => from === name || from.startsWith(`${name}.`));
    if (lookup) return { reason: `key field "${key}" comes from the lookup "${lookup}", not from the source` };
    if (!fields.includes(from)) fields.push(from);
  }
  return { fields };
}

/**
 * The source key of a row, or undefined when a key value is empty or neither text nor a number.
 * Other values (dates, ObjectIds, decimals) would not survive the run record's JSON in a form that MongoDB
 * and Cosmos DB, which compare types strictly, match again.
 */
export function sourceKeyOf(row: Row, fields: readonly string[]): SourceKey | undefined {
  const key: SourceKey = {};
  for (const field of fields) {
    const value = sourceKeyValue(getPath(row, field));
    if (value === undefined) return undefined;
    key[field] = value;
  }
  return key;
}

function sourceKeyValue(value: unknown): string | number | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  // SQL databases cast the text back to the column type when it is bound.
  if (typeof value === 'bigint') return value.toString();
  // BSON numbers (Int32, Long, Double) are numbers again after normalizing; an ObjectId would become text.
  const normalized = value !== null && typeof value === 'object' ? normalizeValue(value) : undefined;
  return typeof normalized === 'number' ? normalized : undefined;
}

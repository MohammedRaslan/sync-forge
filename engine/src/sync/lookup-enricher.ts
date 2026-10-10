import { getPath } from '../common/paths';
import { keyString, normalizeValue } from '../common/values';
import { KeyReader, Row } from '../connectors/connector.types';
import { Lookup } from '../jobs/job.model';
import { findAllByKeys } from './key-lookup';

export interface OpenLookup {
  spec: Lookup;
  reader: KeyReader;
}

/** A source row with its lookups attached, or the reason a required lookup failed. */
export interface EnrichedRow {
  row: Row;
  error?: string;
}

/**
 * Source fields worth fetching: the mapper's fields, minus paths that belong to a lookup,
 * plus the source fields lookups match on. Undefined means every field.
 */
export function readFields(mapperFields: string[] | undefined, lookups: readonly Lookup[]): string[] | undefined {
  if (mapperFields === undefined || lookups.length === 0) return mapperFields;
  const names = lookups.map((lookup) => lookup.as);
  const ownField = (path: string) => !names.some((name) => path === name || path.startsWith(`${name}.`));
  const matchFields = lookups.flatMap((lookup) => lookup.on.map((pair) => pair.source));
  const fields = [...new Set([...mapperFields, ...matchFields].filter(ownField))];
  return fields.length > 0 ? fields : undefined;
}

/**
 * Applies a job's lookups to a batch of source rows. Each lookup costs one query per
 * batch (more for large batches), never one per row. Lookups run in order, so a lookup
 * may match on fields that an earlier lookup attached (order → customer → region).
 */
export class LookupEnricher {
  static readonly none = new LookupEnricher([]);

  constructor(private readonly lookups: readonly OpenLookup[]) {}

  /** See `readFields`. */
  sourceFields(mapperFields: string[] | undefined): string[] | undefined {
    return readFields(mapperFields, this.lookups.map(({ spec }) => spec));
  }

  async enrich(rows: readonly Row[]): Promise<EnrichedRow[]> {
    // Copies, so source rows are never mutated.
    const results: EnrichedRow[] = rows.map((row) => ({ row: { ...row } }));
    for (const lookup of this.lookups) await this.apply(lookup, results.filter((result) => result.error === undefined));
    return results;
  }

  private async apply({ spec, reader }: OpenLookup, results: EnrichedRow[]): Promise<void> {
    const lookupFields = spec.on.map((pair) => pair.lookup);
    const wanted = new Map<string, Row>();
    const rowKeys = results.map(({ row }) => {
      const values = spec.on.map((pair) => getPath(row, pair.source));
      if (values.some((value) => value === null || value === undefined)) return undefined;
      const key = keyString(values);
      if (!wanted.has(key)) wanted.set(key, Object.fromEntries(lookupFields.map((field, index) => [field, values[index]])));
      return key;
    });

    const matches = new Map<string, Row>();
    for (const found of await findAllByKeys(reader, spec.collection, lookupFields, [...wanted.values()])) {
      const key = keyString(lookupFields.map((field) => getPath(found, field)));
      // Lookups are many-to-one: if several rows match, the first one wins.
      if (!matches.has(key)) matches.set(key, found);
    }

    results.forEach((result, index) => {
      const key = rowKeys[index];
      const match = key === undefined ? undefined : matches.get(key);
      if (match) result.row[spec.as] = match;
      else if (spec.required) result.error = `no ${spec.as} found where ${describeKey(spec, result.row)}`;
      else result.row[spec.as] = null;
    });
  }
}

function describeKey(spec: Lookup, row: Row): string {
  return spec.on
    .map((pair) => `${pair.lookup} = ${JSON.stringify(normalizeValue(getPath(row, pair.source)))}`)
    .join(' and ');
}

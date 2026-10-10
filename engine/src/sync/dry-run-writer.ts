import { getPath } from '../common/paths';
import { keyString, normalizeValue } from '../common/values';
import { DataWriter, KeyReader, Row } from '../connectors/connector.types';
import { findAllByKeys } from './key-lookup';
import type { Pipeline } from './sync.service';
import { differingFields, displayKey } from './row-diff';

/** How the target would change if the job ran for real. */
export interface DryRunReport {
  inserts: number;
  updates: number;
  unchanged: number;
  /** Keys of rows that would be inserted (the first ones only). */
  newKeys: string[];
  /** Field changes of rows that would be updated (the first ones only). `removed`: the field would disappear. */
  changes: Array<{ key: string; field: string; current: unknown; next: unknown; removed?: true }>;
}

export interface DryRunOptions {
  /** The target replaces whole documents (Cosmos DB), so fields the job does not map would be removed. */
  replacesWholeDocument?: boolean;
}

/** Enough examples to judge a run without making the run record large. */
const SAMPLE_LIMIT = 100;

/**
 * Takes the target writer's place during a dry run. Instead of writing, it looks up the rows that
 * would be written (one query per batch) and records whether each would be inserted, updated or
 * left as it is. Nothing is ever written.
 */
export class DryRunWriter implements DataWriter {
  readonly report: DryRunReport = { inserts: 0, updates: 0, unchanged: 0, newKeys: [], changes: [] };
  /** Keys this dry run already counted as inserts: nothing is written, so a later batch would not find them. */
  private readonly plannedInserts = new Set<string>();

  constructor(
    private readonly target: KeyReader,
    private readonly options: DryRunOptions = {},
  ) {}

  async upsert(collection: string, rows: Row[], keyFields: string[]): Promise<void> {
    const keyOf = (row: Row) => keyString(keyFields.map((field) => getPath(row, field)));
    const keys = rows.map((row) => Object.fromEntries(keyFields.map((field) => [field, row[field]])));
    const existing = new Map((await findAllByKeys(this.target, collection, keyFields, keys)).map((row) => [keyOf(row), row]));

    for (const row of rows) {
      const key = keyOf(row);
      const current = existing.get(key);
      if (!current) {
        if (this.plannedInserts.has(key)) {
          // Inserted by an earlier batch of this run, so a real run would update it now.
          this.report.updates += 1;
          continue;
        }
        this.plannedInserts.add(key);
        this.report.inserts += 1;
        if (this.report.newKeys.length < SAMPLE_LIMIT) this.report.newKeys.push(displayKey(row, keyFields));
        continue;
      }
      const changed = differingFields(row, current, Object.keys(row));
      const removed = this.options.replacesWholeDocument ? unmappedFields(row, current) : [];
      if (changed.length === 0 && removed.length === 0) {
        this.report.unchanged += 1;
        continue;
      }
      this.report.updates += 1;
      const changes = [
        ...changed.map((field) => ({ field, current: getPath(current, field), next: row[field] })),
        ...removed.map((field) => ({ field, current: current[field], next: null, removed: true as const })),
      ];
      for (const change of changes) {
        if (this.report.changes.length >= SAMPLE_LIMIT) break;
        this.report.changes.push({
          ...change,
          key: displayKey(row, keyFields),
          current: normalizeValue(change.current),
          next: normalizeValue(change.next),
        });
      }
    }
  }

  findByKeys(collection: string, keyFields: string[], keys: Row[]): Promise<Row[]> {
    return this.target.findByKeys(collection, keyFields, keys);
  }
}

/** Top-level fields of the current document that none of the written paths cover. */
function unmappedFields(row: Row, current: Row): string[] {
  const written = new Set(Object.keys(row).map((path) => path.split('.')[0]));
  return Object.keys(current).filter((field) => !written.has(field));
}

/** The dry-run writer for a pipeline's target; Cosmos DB targets replace whole documents. */
export function dryRunWriterFor(pipeline: Pick<Pipeline, 'target' | 'targetConnection'>): DryRunWriter {
  return new DryRunWriter(pipeline.target, { replacesWholeDocument: pipeline.targetConnection.kind === 'cosmos' });
}

import { z } from 'zod';
import { ValidationError } from '../common/errors';
import { isSafeFieldPath } from '../common/paths';
import { TRANSFORM_DEFINITIONS, TRANSFORM_NAMES } from '../transforms/transform.registry';
import { StoredWatermark } from '../sync/watermark';
import { FilterOp, SourceFilter, SourceScope } from '../connectors/connector.types';

const fieldPath = z
  .string()
  .trim()
  .min(1, 'Required')
  .max(200)
  .refine(isSafeFieldPath, 'Use a field name or dotted path such as address.city (no "$")');

export const fieldMappingSchema = z.object({
  from: fieldPath.optional(),
  to: fieldPath,
  transform: z.enum(TRANSFORM_NAMES).default('none'),
  argument: z.string().max(2000).optional(),
});

export const FILTER_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const satisfies readonly FilterOp[];
export const FILTER_VALUE_TYPES = ['string', 'number', 'date', 'boolean'] as const;

/** The typed value of a filter, or undefined when the text does not fit the type. */
export function parseFilterValue(type: (typeof FILTER_VALUE_TYPES)[number], text: string): unknown {
  switch (type) {
    case 'string':
      return text;
    case 'number': {
      const number = text.trim() === '' ? Number.NaN : Number(text);
      // Integers beyond 2^53 would silently become a different number (and match a different row).
      if (/^\s*-?\d+\s*$/.test(text) && !Number.isSafeInteger(number)) return undefined;
      return Number.isFinite(number) ? number : undefined;
    }
    case 'date': {
      // A date-time without an offset means UTC, so a spec gives the same result on every machine.
      const withZone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text.trim()) ? `${text.trim()}Z` : text;
      const date = new Date(withZone);
      return text.trim() === '' || Number.isNaN(date.getTime()) ? undefined : date;
    }
    case 'boolean':
      return text === 'true' ? true : text === 'false' ? false : undefined;
  }
}

const FILTER_VALUE_HINT = {
  string: 'text',
  number: 'a number (whole numbers up to 9007199254740991; use text for larger ids)',
  date: 'a date such as 2025-01-31 or 2025-01-31T08:00:00Z',
  boolean: 'true or false',
};

/**
 * A condition on source rows, e.g. created_at > 2025-01-01. The value is kept as text in the
 * spec (diff-friendly) with its type, and converted once when the job is opened.
 */
export const sourceFilterSchema = z
  .object({
    field: fieldPath,
    op: z.enum(FILTER_OPS),
    type: z.enum(FILTER_VALUE_TYPES).default('string'),
    value: z.string().max(200),
  })
  .superRefine((filter, ctx) => {
    if (parseFilterValue(filter.type, filter.value) === undefined) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: `Must be ${FILTER_VALUE_HINT[filter.type]}` });
    }
  });

export type SourceFilterSpec = z.infer<typeof sourceFilterSchema>;

/**
 * Job files are read from disk without re-validation, so a hand-edited condition is checked here
 * rather than trusted: a value that does not fit would otherwise bind as null and read the wrong rows.
 */
export function toSourceFilter(filter: SourceFilterSpec): SourceFilter {
  const type = filter.type ?? 'string';
  const value = parseFilterValue(type, String(filter.value ?? ''));
  if (value === undefined) {
    throw new ValidationError(`Condition on "${filter.field}": "${filter.value}" must be ${FILTER_VALUE_HINT[type]}`);
  }
  return { field: filter.field, op: filter.op, value };
}

/**
 * A lookup enriches each source row with one matching row from another collection
 * (a many-to-one join, like order → customer). The match is attached to the row under
 * `as`, so mappings read `customer.email` and expressions see `row.customer`.
 */
export const lookupSchema = z.object({
  as: z
    .string()
    .trim()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Use letters, digits and _, e.g. customer')
    .max(40),
  connectionId: z.string().min(1, 'Choose a connection'),
  collection: z.string().trim().min(1, 'Choose a table or collection'),
  /** Source field → lookup field pairs that must all match. Source fields may use earlier lookups. */
  on: z
    .array(z.object({ source: fieldPath, lookup: fieldPath }))
    .min(1, 'Match on at least one field')
    .max(5),
  /** When true, a source row without a match is a row error; otherwise its lookup fields are empty. */
  required: z.boolean().default(false),
});

const jobShape = z.object({
  name: z.string().trim().min(1, 'Required').max(80),
  description: z.string().trim().max(500).optional(),
  source: z.object({
    connectionId: z.string().min(1, 'Choose a source connection'),
    /** For a query source: the name shown for it, like naming a view. */
    collection: z.string().trim().min(1, 'Choose a source collection'),
    /** PostgreSQL only: a SELECT read instead of a table. */
    query: z.string().trim().min(1, 'Write a query').max(20_000).optional(),
    /** Only rows matching every filter are read. */
    filters: z.array(sourceFilterSchema).max(10).optional(),
  }),
  lookups: z.array(lookupSchema).max(5).optional(),
  target: z.object({
    connectionId: z.string().min(1, 'Choose a target connection'),
    collection: z.string().trim().min(1, 'Choose a target collection'),
    keyFields: z.array(fieldPath).min(1, 'Choose at least one key field to match rows on'),
  }),
  mappings: z.array(fieldMappingSchema).min(1, 'Map at least one field').max(500),
  mode: z.enum(['full', 'incremental']).default('full'),
  watermarkField: fieldPath.optional(),
  batchSize: z.coerce.number().int().min(1).max(10_000).default(500),
  errorPolicy: z.enum(['fail', 'skip']).default('fail'),
});

/** Rules across fields, shared by saved jobs and previews. */
function checkJob(job: z.infer<typeof jobShape>, ctx: z.RefinementCtx): void {
  if (job.mode === 'incremental' && !job.watermarkField) {
    ctx.addIssue({ code: 'custom', path: ['watermarkField'], message: 'Incremental runs need a watermark field' });
  }

  const targets = new Set<string>();
  job.mappings.forEach((mapping, index) => {
    if (targets.has(mapping.to)) {
      ctx.addIssue({ code: 'custom', path: ['mappings', index, 'to'], message: `"${mapping.to}" is mapped twice` });
    }
    targets.add(mapping.to);

    const sourceField = TRANSFORM_DEFINITIONS.get(mapping.transform)?.sourceField;
    if (sourceField === 'required' && !mapping.from) {
      ctx.addIssue({ code: 'custom', path: ['mappings', index, 'from'], message: 'Choose a source field' });
    }
  });

  const lookups = job.lookups ?? [];
  const underLookup = (path: string, names: readonly string[]) =>
    names.some((name) => path === name || path.startsWith(`${name}.`));
  lookups.forEach((lookup, index) => {
    const earlier = lookups.slice(0, index).map((other) => other.as);
    if (earlier.includes(lookup.as)) {
      ctx.addIssue({ code: 'custom', path: ['lookups', index, 'as'], message: `"${lookup.as}" is used twice` });
    }
    const laterOrSelf = lookups.slice(index).map((other) => other.as);
    lookup.on.forEach((pair, pairIndex) => {
      if (underLookup(pair.source, laterOrSelf)) {
        ctx.addIssue({
          code: 'custom',
          path: ['lookups', index, 'on', pairIndex, 'source'],
          message: 'A lookup can only match on source fields or fields of earlier lookups',
        });
      }
    });
  });
  const lookupNames = lookups.map((lookup) => lookup.as);
  if (job.watermarkField && underLookup(job.watermarkField, lookupNames)) {
    ctx.addIssue({ code: 'custom', path: ['watermarkField'], message: 'The watermark must be a field of the source itself' });
  }
  job.source.filters?.forEach((filter, index) => {
    if (underLookup(filter.field, lookupNames)) {
      ctx.addIssue({
        code: 'custom',
        path: ['source', 'filters', index, 'field'],
        message: 'Conditions apply to source fields; lookup fields are not read from the source',
      });
    }
  });

  job.target.keyFields.forEach((key, index) => {
    if (!targets.has(key)) {
      ctx.addIssue({ code: 'custom', path: ['target', 'keyFields', index], message: `Key "${key}" is not a mapped target field` });
    }
  });
}

export const jobInputSchema = jobShape.superRefine(checkJob);

/**
 * Source rows and the read statement can be previewed before a target or mappings exist.
 * Mappings and lookups are only used to work out which fields would be read.
 */
export const sourcePreviewSchema = jobShape
  .pick({ source: true, lookups: true, mode: true, watermarkField: true })
  .extend({ mappings: z.array(fieldMappingSchema).max(500).default([]) });

export type SourcePreviewInput = z.infer<typeof sourcePreviewSchema>;

/** A preview runs on an unsaved draft, which may not have a name yet. */
export const previewInputSchema = jobShape.extend({ name: z.string().trim().max(80).default('') }).superRefine(checkJob);

export type FieldMapping = z.infer<typeof fieldMappingSchema>;

/** Which source rows a job reads: its query (if any) and its filters with typed values. */
export function sourceScope(source: JobInput['source']): SourceScope {
  return { query: source.query, filters: source.filters?.map(toSourceFilter) };
}
export type Lookup = z.infer<typeof lookupSchema>;
export type JobInput = z.infer<typeof jobInputSchema>;

export interface Job extends JobInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

/** Machine-local progress for incremental jobs. Kept apart from the spec so specs stay shareable. */
export interface JobState {
  id: string;
  watermark: StoredWatermark | null;
  updatedAt: string;
}

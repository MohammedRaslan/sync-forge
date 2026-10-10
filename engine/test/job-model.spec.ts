import { describe, expect, it } from 'vitest';
import { JobInput, jobInputSchema, parseFilterValue, previewInputSchema, sourceScope, toSourceFilter } from '../src/jobs/job.model';

function job(overrides: Partial<JobInput> = {}): unknown {
  return {
    name: 'Orders',
    source: { connectionId: 'legacy', collection: 'public.orders' },
    target: { connectionId: 'newcore', collection: 'public.orders', keyFields: ['id'] },
    mappings: [
      { from: 'order_no', to: 'id' },
      { from: 'customer.email', to: 'email' },
    ],
    lookups: [{ as: 'customer', connectionId: 'crm', collection: 'customers', on: [{ source: 'customer_ref', lookup: 'ref' }] }],
    ...overrides,
  };
}

function issues(input: unknown): string[] {
  const result = jobInputSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

describe('job schema: lookups and query sources', () => {
  it('accepts a job with a lookup and defaults it to optional', () => {
    const parsed = jobInputSchema.parse(job());
    expect(parsed.lookups?.[0].required).toBe(false);
  });

  it('keeps jobs without lookups valid', () => {
    expect(issues(job({ lookups: undefined }))).toEqual([]);
  });

  it('accepts a query source', () => {
    const source = { connectionId: 'legacy', collection: 'orders_with_totals', query: 'SELECT 1 AS id' };
    expect(issues(job({ source }))).toEqual([]);
  });

  it('rejects lookup names that are not simple identifiers or are used twice', () => {
    const first = { as: 'customer', connectionId: 'crm', collection: 'customers', on: [{ source: 'a', lookup: 'b' }] };
    expect(issues(job({ lookups: [{ ...first, as: 'cust.omer', required: false }] }))).toEqual([
      'lookups.0.as: Use letters, digits and _, e.g. customer',
    ]);
    expect(issues(job({ lookups: [{ ...first, required: false }, { ...first, required: false }] }))).toEqual([
      'lookups.1.as: "customer" is used twice',
    ]);
  });

  it('only lets a lookup match on source fields or fields of earlier lookups', () => {
    const lookups = [
      { as: 'customer', connectionId: 'crm', collection: 'customers', on: [{ source: 'region.id', lookup: 'regionId' }], required: false },
      { as: 'region', connectionId: 'crm', collection: 'regions', on: [{ source: 'customer.regionId', lookup: 'id' }], required: false },
    ];
    expect(issues(job({ lookups }))).toEqual([
      'lookups.0.on.0.source: A lookup can only match on source fields or fields of earlier lookups',
    ]);
  });

  it('rejects a watermark taken from a lookup', () => {
    expect(issues(job({ mode: 'incremental', watermarkField: 'customer.updated_at' }))).toEqual([
      'watermarkField: The watermark must be a field of the source itself',
    ]);
  });
});

describe('preview schema', () => {
  it('previews a draft that has no name yet, which saving still rejects', () => {
    expect(previewInputSchema.safeParse(job({ name: '' })).success).toBe(true);
    expect(previewInputSchema.safeParse(job({ name: undefined })).success).toBe(true);
    expect(issues(job({ name: '' }))).toEqual(['name: Required']);
  });

  it('applies the same cross-field rules as saving', () => {
    const result = previewInputSchema.safeParse(job({ mode: 'incremental' }));
    expect(result.success).toBe(false);
  });
});

describe('source filters', () => {
  const source = (filters: unknown[]) => ({ connectionId: 'legacy', collection: 'public.orders', filters });

  it('accepts typed conditions and converts their values once', () => {
    const filters = [
      { field: 'created_at', op: 'gt', type: 'date', value: '2025-01-31' },
      { field: 'qty', op: 'lte', type: 'number', value: '10' },
      { field: 'active', op: 'eq', type: 'boolean', value: 'true' },
      { field: 'status', op: 'ne', value: 'cancelled' },
    ];
    const parsed = jobInputSchema.parse(job({ source: source(filters) as JobInput['source'] }));
    expect(sourceScope(parsed.source).filters).toEqual([
      { field: 'created_at', op: 'gt', value: new Date('2025-01-31') },
      { field: 'qty', op: 'lte', value: 10 },
      { field: 'active', op: 'eq', value: true },
      { field: 'status', op: 'ne', value: 'cancelled' },
    ]);
  });

  it('rejects values that do not fit their type', () => {
    const filters = [
      { field: 'qty', op: 'gt', type: 'number', value: 'ten' },
      { field: 'created_at', op: 'gt', type: 'date', value: 'last week' },
      { field: 'active', op: 'eq', type: 'boolean', value: 'yes' },
    ];
    expect(issues(job({ source: source(filters) as JobInput['source'] }))).toEqual([
      'source.filters.0.value: Must be a number (whole numbers up to 9007199254740991; use text for larger ids)',
      'source.filters.1.value: Must be a date such as 2025-01-31 or 2025-01-31T08:00:00Z',
      'source.filters.2.value: Must be true or false',
    ]);
  });

  it('reads a date-time without an offset as UTC, on every machine', () => {
    expect(parseFilterValue('date', '2025-01-31T08:00')).toEqual(new Date('2025-01-31T08:00:00Z'));
    expect(parseFilterValue('date', '2025-01-31')).toEqual(new Date('2025-01-31T00:00:00Z'));
  });

  it('rejects whole numbers that cannot be represented exactly', () => {
    expect(parseFilterValue('number', '9007199254740993')).toBeUndefined();
    expect(parseFilterValue('number', '12.5')).toBe(12.5);
  });

  it('checks conditions from hand-edited job files instead of trusting them', () => {
    expect(toSourceFilter({ field: 'status', op: 'eq', value: 'NEW' } as never)).toEqual({ field: 'status', op: 'eq', value: 'NEW' });
    expect(() => toSourceFilter({ field: 'created_at', op: 'gt', type: 'date', value: '31/01/2025' })).toThrow(
      'Condition on "created_at": "31/01/2025" must be a date',
    );
  });

  it('rejects conditions on lookup fields', () => {
    const filters = [{ field: 'customer.country', op: 'eq', type: 'string', value: 'DE' }];
    expect(issues(job({ source: source(filters) as JobInput['source'] }))).toEqual([
      'source.filters.0.field: Conditions apply to source fields; lookup fields are not read from the source',
    ]);
  });
});

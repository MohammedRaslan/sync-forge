import { describe, expect, it } from 'vitest';
import {
  buildCount,
  buildKeyLookup,
  buildSelect,
  buildUpsert,
  inlineSql,
  normalizeQuery,
  parseTableName,
  quoteIdent,
} from '../src/connectors/postgres/postgres-sql';

const table = { schema: 'public', table: 'customers' };

describe('postgres sql builders', () => {
  it('quotes identifiers so names cannot break out of the statement', () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });

  it('parses schema-qualified names', () => {
    expect(parseTableName('sales.orders')).toEqual({ schema: 'sales', table: 'orders' });
    expect(parseTableName('orders')).toEqual({ schema: 'public', table: 'orders' });
  });

  it('builds an incremental select ordered by the watermark', () => {
    const query = buildSelect(table, { columns: ['id'], watermark: { column: 'updated_at', from: 'x' } });
    expect(query.text).toBe(
      'SELECT "id", "updated_at" FROM "public"."customers" WHERE "updated_at" >= $1 ORDER BY "updated_at" ASC NULLS LAST',
    );
    expect(query.values).toEqual(['x']);
  });

  it('builds a multi-row upsert', () => {
    const query = buildUpsert(table, ['id', 'name'], ['id'], [[1, 'a'], [2, 'b']]);
    expect(query.text).toBe(
      'INSERT INTO "public"."customers" ("id", "name") VALUES ($1, $2), ($3, $4) ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name"',
    );
    expect(query.values).toEqual([1, 'a', 2, 'b']);
  });

  it('does nothing on conflict when every column is a key', () => {
    expect(buildUpsert(table, ['id'], ['id'], [[1]]).text).toContain('ON CONFLICT ("id") DO NOTHING');
  });

  it('looks up composite keys', () => {
    const query = buildKeyLookup(table, ['a', 'b'], [[1, 2], [3, 4]]);
    expect(query.text).toBe('SELECT * FROM "public"."customers" WHERE ("a", "b") IN (($1, $2), ($3, $4))');
  });

  it('wraps a query source as a subquery, so watermarks and projections still apply', () => {
    const query = buildSelect(
      { query: 'SELECT o.id, c.email, o.updated_at FROM orders o JOIN customers c ON c.id = o.customer_id;' },
      { columns: ['id', 'email'], watermark: { column: 'updated_at', from: 'x' } },
    );
    expect(query.text).toBe(
      'SELECT "id", "email", "updated_at" FROM (SELECT o.id, c.email, o.updated_at FROM orders o JOIN customers c ON c.id = o.customer_id) AS "q" ' +
        'WHERE "updated_at" >= $1 ORDER BY "updated_at" ASC NULLS LAST',
    );
  });

  it('keeps the subquery valid when the query ends with a line comment', () => {
    const query = buildSelect(
      { query: 'SELECT id, updated_at FROM orders -- only orders' },
      { watermark: { column: 'updated_at', from: 5 } },
    );
    expect(query.text).toBe(
      'SELECT * FROM (SELECT id, updated_at FROM orders -- only orders\n) AS "q" WHERE "updated_at" >= $1 ORDER BY "updated_at" ASC NULLS LAST',
    );
  });

  it('counts tables and query sources', () => {
    expect(buildCount(table).text).toBe('SELECT count(*)::bigint AS total FROM "public"."customers"');
    expect(buildCount({ query: 'SELECT 1' }).text).toBe('SELECT count(*)::bigint AS total FROM (SELECT 1) AS "q"');
  });

  it('drops trailing semicolons and rejects empty queries', () => {
    expect(normalizeQuery('  SELECT 1 ;; \n')).toBe('SELECT 1');
    expect(() => normalizeQuery(' ; ')).toThrow('The query is empty');
  });


  it('adds filters as bound conditions before the watermark', () => {
    const query = buildSelect(table, {
      columns: ['id'],
      watermark: { column: 'updated_at', from: 'w' },
      filters: [
        { field: 'created_at', op: 'gt', value: 'd' },
        { field: 'status', op: 'ne', value: 'x' },
      ],
    });
    expect(query.text).toBe(
      'SELECT "id", "updated_at" FROM "public"."customers" WHERE "created_at" > $1 AND "status" IS DISTINCT FROM $2 ' +
        'AND "updated_at" >= $3 ORDER BY "updated_at" ASC NULLS LAST',
    );
    expect(query.values).toEqual(['d', 'x', 'w']);
  });

  it('counts only rows matching the filters', () => {
    const query = buildCount(table, [{ field: 'qty', op: 'gte', value: 5 }]);
    expect(query).toEqual({ text: 'SELECT count(*)::bigint AS total FROM "public"."customers" WHERE "qty" >= $1', values: [5] });
  });

  it('writes values into a statement for people to read and run, quoting text safely', () => {
    const text = inlineSql({
      text: 'SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $10 AND d = $3 AND e = $4',
      values: ["O'Brien", 42, null, new Date('2025-01-31T00:00:00Z'), 5, 6, 7, 8, 9, true],
    });
    expect(text).toBe("SELECT * FROM t WHERE a = 'O''Brien' AND b = 42 AND c = TRUE AND d = NULL AND e = '2025-01-31T00:00:00.000Z'");
  });
});

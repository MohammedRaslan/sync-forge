import { describe, expect, it } from 'vitest';
import {
  buildCount,
  buildExistingKeys,
  buildInsert,
  buildKeyLookup,
  buildSelect,
  buildUpdate,
  inlineStatement,
  mysqlLiteral,
  parseMysqlTableName,
  quoteIdent,
} from '../src/connectors/mysql/mysql-sql';

const table = { table: 'customers' };

describe('mysql sql builders', () => {
  it('quotes identifiers so names cannot break out of the statement', () => {
    expect(quoteIdent('we`ird')).toBe('`we``ird`');
    expect(parseMysqlTableName('crm.customers')).toEqual({ database: 'crm', table: 'customers' });
    expect(parseMysqlTableName('customers')).toEqual({ table: 'customers' });
  });

  it('escapes literals, with dates in UTC and objects as JSON', () => {
    expect(mysqlLiteral("O'Brien")).toBe("'O\\'Brien'");
    expect(mysqlLiteral(new Date('2025-01-31T08:00:00Z'))).toBe("'2025-01-31 08:00:00.000'");
    expect(mysqlLiteral({ a: 1 })).toBe('\'{\\"a\\":1}\'');
    expect([mysqlLiteral(null), mysqlLiteral(true), mysqlLiteral(5)]).toEqual(['NULL', 'TRUE', '5']);
  });

  it('builds an incremental, filtered select with nulls last', () => {
    const sql = buildSelect(table, {
      columns: ['id'],
      watermark: { column: 'updated_at', from: new Date('2025-01-01T00:00:00Z') },
      filters: [{ field: 'status', op: 'ne', value: 'x' }],
      limit: 10,
    });
    expect(sql).toBe(
      "SELECT `id`, `updated_at` FROM `customers` WHERE NOT (`status` <=> 'x') AND `updated_at` >= '2025-01-01 00:00:00.000' " +
        'ORDER BY `updated_at` IS NULL, `updated_at` ASC LIMIT 10',
    );
  });

  it('wraps query sources and counts them with filters', () => {
    expect(buildCount({ query: 'SELECT 1 AS n;' }, [{ field: 'n', op: 'gt', value: 0 }])).toBe(
      'SELECT COUNT(*) AS total FROM (SELECT 1 AS n) AS `q` WHERE `n` > 0',
    );
  });

  it('keeps the subquery valid when the query ends with a line comment', () => {
    expect(buildCount({ query: 'SELECT 1 AS n -- one row' })).toBe('SELECT COUNT(*) AS total FROM (SELECT 1 AS n -- one row\n) AS `q`');
    expect(buildCount({ query: 'SELECT 1 AS n # one row' })).toBe('SELECT COUNT(*) AS total FROM (SELECT 1 AS n # one row\n) AS `q`');
  });

  it('builds prepared key lookups, inserts and updates', () => {
    expect(buildKeyLookup(table, ['id'], [[1], [2]])).toEqual({ sql: 'SELECT * FROM `customers` WHERE `id` IN (?, ?)', values: [1, 2] });
    expect(buildExistingKeys(table, ['a', 'b'], [[1, 2]]).sql).toBe('SELECT `a`, `b` FROM `customers` WHERE (`a`, `b`) IN ((?, ?)) FOR UPDATE');
    expect(buildInsert(table, ['id', 'name'], [[1, 'a'], [2, 'b']])).toEqual({
      sql: 'INSERT INTO `customers` (`id`, `name`) VALUES (?, ?), (?, ?)',
      values: [1, 'a', 2, 'b'],
    });
    expect(buildUpdate(table, { id: 1, name: 'a' }, ['id'])).toEqual({ sql: 'UPDATE `customers` SET `name` = ? WHERE `id` = ?', values: ['a', 1] });
    expect(buildUpdate(table, { id: 1 }, ['id'])).toBeUndefined();
  });

  it('writes values into prepared statements for display', () => {
    expect(inlineStatement({ sql: 'SELECT * FROM t WHERE a = ? AND b = ?', values: ["it's", { x: 1 }] })).toBe(
      'SELECT * FROM t WHERE a = \'it\\\'s\' AND b = \'{\\"x\\":1}\'',
    );
  });
});

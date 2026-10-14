import { parse } from 'csv-parse/sync';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../src/common/errors';
import { SourceFilter } from '../src/connectors/connector.types';
import {
  castCell,
  checkHeader,
  csvErrorMessage,
  describeKeyLookup,
  describeRead,
  detectDelimiter,
  isSafeCsvFileName,
  matchesFilters,
} from '../src/connectors/csv/csv-format';

/** Parses CSV text the way the connector does. */
function parseCsv(text: string, file = 'data.csv'): Record<string, string | null>[] {
  return parse(text, {
    bom: true,
    columns: (header: (string | null)[]) => checkHeader(header, file),
    cast: castCell,
    relax_column_count: false,
    skip_empty_lines: true,
  });
}

function parseError(text: string): unknown {
  try {
    parseCsv(text);
  } catch (error) {
    return error;
  }
  throw new Error('expected the CSV to be refused');
}

describe('detectDelimiter', () => {
  it('picks the separator used most often', () => {
    expect(detectDelimiter('id,name,city')).toBe(',');
    expect(detectDelimiter('id;name;city')).toBe(';');
    expect(detectDelimiter('id\tname\tcity')).toBe('\t');
  });

  it('ignores separators inside quoted names', () => {
    expect(detectDelimiter('"last, first";"city, country";id')).toBe(';');
    expect(detectDelimiter('"a ""quoted"", name"\tb')).toBe('\t');
  });

  it('defaults to a comma for a single column', () => {
    expect(detectDelimiter('id')).toBe(',');
  });
});

describe('isSafeCsvFileName', () => {
  it('accepts plain file names', () => {
    expect(isSafeCsvFileName('customers.csv')).toBe(true);
    expect(isSafeCsvFileName('Orders 2025-01_v2.CSV')).toBe(true);
  });

  it('refuses folders, dot files and other extensions', () => {
    for (const name of ['../x.csv', 'a/b.csv', 'a\\b.csv', '.hidden.csv', 'x.txt', '.csv', `${'a'.repeat(101)}.csv`]) {
      expect(isSafeCsvFileName(name), name).toBe(false);
    }
  });

  it('refuses names Windows reserves for devices, in any case', () => {
    for (const name of ['con.csv', 'PRN.csv', 'Aux.CSV', 'nul.csv', 'COM1.csv', 'lpt9.csv']) {
      expect(isSafeCsvFileName(name), name).toBe(false);
    }
    for (const name of ['console.csv', 'com.csv', 'nul1x.csv', 'my con.csv']) {
      expect(isSafeCsvFileName(name), name).toBe(true);
    }
  });
});

describe('castCell', () => {
  it('reads an unquoted empty cell as null and a quoted one as an empty string', () => {
    expect(castCell('', { quoting: false })).toBeNull();
    expect(castCell('', { quoting: true })).toBe('');
    expect(castCell('42', { quoting: false })).toBe('42');
  });

  it('keeps every cell as text when parsing', () => {
    expect(parseCsv('a,b,c\n,"",7\n')).toEqual([{ a: null, b: '', c: '7' }]);
  });
});

describe('checkHeader', () => {
  it('returns the header names in order', () => {
    expect(checkHeader(['id', 'name', 'address.city'], 'a.csv')).toEqual(['id', 'name', 'address.city']);
  });

  it('refuses empty, duplicate and unsafe names', () => {
    expect(() => checkHeader(['id', null], 'a.csv')).toThrow(ValidationError);
    expect(() => checkHeader(['id', '  '], 'a.csv')).toThrow('a.csv: column 2 of the header row has no name');
    expect(() => checkHeader(['id', 'id'], 'a.csv')).toThrow('column "id" appears twice');
    expect(() => checkHeader(['__proto__'], 'a.csv')).toThrow('not a usable field name');
  });

  it('refuses a bad header while parsing', () => {
    expect(parseError('id,,name\n1,2,3\n')).toBeInstanceOf(ValidationError);
  });

  it('strips a byte order mark from the first name', () => {
    expect(parseCsv('﻿id\n1\n')).toEqual([{ id: '1' }]);
  });
});

describe('matchesFilters', () => {
  const filter = (field: string, op: SourceFilter['op'], value: unknown): SourceFilter => ({ field, op, value });

  it('matches every row when there are no filters', () => {
    expect(matchesFilters({ a: null }, [])).toBe(true);
  });

  it('compares text ordinally', () => {
    const row = { status: 'paid' };
    expect(matchesFilters(row, [filter('status', 'eq', 'paid')])).toBe(true);
    expect(matchesFilters(row, [filter('status', 'eq', 'Paid')])).toBe(false);
    expect(matchesFilters(row, [filter('status', 'gt', 'open')])).toBe(true);
    expect(matchesFilters(row, [filter('status', 'lte', 'open')])).toBe(false);
  });

  it('reads cells as numbers for a number filter', () => {
    const row = { amount: '10.50' };
    expect(matchesFilters(row, [filter('amount', 'eq', 10.5)])).toBe(true);
    expect(matchesFilters(row, [filter('amount', 'gt', 9)])).toBe(true);
    // Text order would put "10.50" before "9".
    expect(matchesFilters(row, [filter('amount', 'lt', 9)])).toBe(false);
    expect(matchesFilters(row, [filter('amount', 'gte', 10.5), filter('amount', 'lte', 10.5)])).toBe(true);
  });

  it('does not match a cell that is not a number against a number filter', () => {
    for (const op of ['eq', 'ne', 'gt', 'lt'] as const) {
      expect(matchesFilters({ amount: 'n/a' }, [filter('amount', op, 5)]), op).toBe(false);
    }
    expect(matchesFilters({ amount: '' }, [filter('amount', 'eq', 0)])).toBe(false);
  });

  it('reads cells as dates for a date filter, without an offset meaning UTC', () => {
    const since = new Date('2025-01-01T00:00:00Z');
    expect(matchesFilters({ at: '2025-03-01' }, [filter('at', 'gt', since)])).toBe(true);
    expect(matchesFilters({ at: '2024-12-31T23:59:59' }, [filter('at', 'lt', since)])).toBe(true);
    expect(matchesFilters({ at: '2025-01-01T00:00:00' }, [filter('at', 'eq', since)])).toBe(true);
    expect(matchesFilters({ at: 'soon' }, [filter('at', 'ne', since)])).toBe(false);
  });

  it('reads true/false/1/0 for a boolean filter', () => {
    expect(matchesFilters({ active: 'true' }, [filter('active', 'eq', true)])).toBe(true);
    expect(matchesFilters({ active: '1' }, [filter('active', 'eq', true)])).toBe(true);
    expect(matchesFilters({ active: '0' }, [filter('active', 'ne', true)])).toBe(true);
    expect(matchesFilters({ active: 'yes' }, [filter('active', 'eq', true)])).toBe(false);
  });

  it('treats cells named like object properties as unreadable for a boolean filter', () => {
    for (const cell of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(matchesFilters({ active: cell }, [filter('active', 'ne', true)]), cell).toBe(false);
      expect(matchesFilters({ active: cell }, [filter('active', 'eq', false)]), cell).toBe(false);
    }
  });

  it('matches an empty cell only for "not equal"', () => {
    for (const op of ['eq', 'gt', 'gte', 'lt', 'lte'] as const) {
      expect(matchesFilters({ status: null }, [filter('status', op, 'paid')]), op).toBe(false);
    }
    expect(matchesFilters({ status: null }, [filter('status', 'ne', 'paid')])).toBe(true);
    expect(matchesFilters({}, [filter('status', 'ne', 5)])).toBe(true);
  });

  it('needs every filter to match', () => {
    const row = { amount: '20', status: 'open' };
    expect(matchesFilters(row, [filter('amount', 'gt', 10), filter('status', 'eq', 'paid')])).toBe(false);
  });
});

describe('describeRead', () => {
  it('describes the file, delimiter, filters and limit', () => {
    const text = describeRead({
      file: 'customers.csv',
      delimiter: ',',
      filters: [
        { field: 'amount', op: 'gt', value: 10 },
        { field: 'status', op: 'eq', value: 'paid' },
      ],
      limit: 10,
    });
    expect(text).toBe('Read "customers.csv" (delimiter ",", header row) keeping rows where amount > 10 and status = "paid", first 10 rows');
  });

  it('names tab and detected delimiters, dates and "not equal"', () => {
    expect(describeRead({ file: 'a.csv', delimiter: '\t' })).toBe('Read "a.csv" (delimiter tab, header row)');
    expect(
      describeRead({
        file: 'a.csv',
        delimiter: 'auto',
        filters: [{ field: 'at', op: 'ne', value: new Date('2025-01-01T00:00:00Z') }],
        limit: 1,
      }),
    ).toBe('Read "a.csv" (delimiter detected from the header row, header row) keeping rows where (at is empty or at != "2025-01-01T00:00:00.000Z"), first 1 row');
  });
});

describe('describeKeyLookup', () => {
  it('lists the keys it matches', () => {
    expect(describeKeyLookup('customers.csv', ['customer_id'], [{ customer_id: 42 }, { customer_id: '43' }])).toBe(
      'Index "customers.csv" by customer_id (once per run), then match 2 keys: 42, "43"',
    );
  });

  it('groups composite keys', () => {
    expect(describeKeyLookup('a.csv', ['region', 'id'], [{ region: 'eu', id: 1 }])).toBe(
      'Index "a.csv" by region, id (once per run), then match 1 key: ("eu", 1)',
    );
  });
});

describe('csvErrorMessage', () => {
  const SEC = 'SECRETCELL';

  it('reports a row with too few or too many columns by line', () => {
    const short = parseError(`a,b,c\n1,2,3\n${SEC},5\n`);
    expect(csvErrorMessage(short, 'customers.csv')).toBe('customers.csv line 3: expected 3 columns, got 2');
    const long = parseError(`a,b\n1,2,${SEC}\n`);
    expect(csvErrorMessage(long, 'customers.csv')).toBe('customers.csv line 2: expected 2 columns, got 3');
  });

  it('reports quoting problems', () => {
    expect(csvErrorMessage(parseError(`a,b\n1,"${SEC}\n`), 'x.csv')).toBe('x.csv line 2: a quoted value is never closed');
    expect(csvErrorMessage(parseError(`a,b\n1,"x"${SEC}\n`), 'x.csv')).toMatch(/^x\.csv line 2: unexpected text after a closing quote/);
  });

  it('never repeats cell text, which csv-parse messages can contain', () => {
    const errors = [`a,b\n${SEC}\n`, `a,b\n1,"${SEC}\n`, `a,b\n1,"x"${SEC}\n`, `a,b\n1,2,${SEC}\n`].map(parseError);
    // csv-parse quotes the offending character itself, e.g. got "S".
    expect((errors[2] as Error).message).toContain('"S"');
    for (const error of errors) {
      const message = csvErrorMessage(error, 'x.csv');
      expect(message).not.toContain(SEC);
      expect(message).not.toContain('"S"');
    }
  });

  it('keeps the message of errors that are not parse errors', () => {
    expect(csvErrorMessage(new ValidationError('x.csv: column "id" appears twice in the header row'), 'x.csv')).toBe(
      'x.csv: column "id" appears twice in the header row',
    );
    expect(csvErrorMessage(new Error('EACCES'), 'x.csv')).toBe('EACCES');
  });
});

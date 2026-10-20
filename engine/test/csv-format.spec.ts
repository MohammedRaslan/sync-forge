import { parse } from 'csv-parse/sync';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../src/common/errors';
import {
  castCell,
  checkHeader,
  csvErrorMessage,
  describeKeyLookup,
  describeRead,
  detectDelimiter,
  isSafeCsvFileName,
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

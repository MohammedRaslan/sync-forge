import { describe, expect, it } from 'vitest';
import { ValidationError } from '../src/common/errors';
import { HttpConfig, HttpEndpoint, httpConfigSchema } from '../src/connections/connection.model';
import {
  FetchedPage,
  PageRequest,
  describeHttpKeyLookup,
  describeHttpRead,
  endpointUrl,
  findArrayPaths,
  firstPage,
  isSendableHeaderValue,
  itemsAt,
  maskedUrl,
  nextPage,
  parseLinkNext,
  rateLimitHeaders,
  retryAfterMs,
  sameOrigin,
  unsafeIntegerIn,
} from '../src/connectors/http/http-format';

/** A made-up credential: the Query tab text must never contain it. */
const SECRET = 'tok-s3cret-123'; // secret-scan: allow

/** A parsed HTTP config with one endpoint `users`; `endpoint` and `overrides` adjust it. */
function makeConfig(endpoint: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}): HttpConfig {
  return httpConfigSchema.parse({
    kind: 'http',
    baseUrl: 'https://api.example.com/v2',
    endpoints: [{ name: 'users', path: '/users', ...endpoint }],
    ...overrides,
  });
}

/** The config and its endpoint for a pagination mode. */
function setup(pagination: Record<string, unknown>, overrides: Record<string, unknown> = {}): { config: HttpConfig; endpoint: HttpEndpoint } {
  const config = makeConfig({ pagination }, overrides);
  return { config, endpoint: config.endpoints[0] };
}

/** A fetched page holding `items` items, with an optional body and headers. */
function fetched(items: number, body: unknown = {}, headers: Record<string, string> = {}): FetchedPage {
  const lower = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return { body, items, headers: { get: (name) => lower.get(name.toLowerCase()) ?? null } };
}

/** Plans pages until the planner stops, feeding it `pages` in order. */
function plan(pagination: Record<string, unknown>, pages: FetchedPage[]): string[] {
  const { config, endpoint } = setup(pagination);
  const urls: string[] = [];
  let request: PageRequest | undefined = firstPage(config, endpoint);
  for (const page of pages) {
    if (!request) break;
    urls.push(request.url);
    request = nextPage(config, endpoint, request, page);
  }
  if (request) urls.push(`then ${request.url}`);
  return urls;
}

describe('endpointUrl', () => {
  it('keeps the base path when joining the endpoint path', () => {
    expect(endpointUrl('https://api.example.com/v2', '/users', [])).toBe('https://api.example.com/v2/users');
    expect(endpointUrl('https://api.example.com/v2/', '/users', [])).toBe('https://api.example.com/v2/users');
    expect(endpointUrl('https://api.example.com', '/users', [])).toBe('https://api.example.com/users');
  });

  it('appends params encoded', () => {
    expect(endpointUrl('https://api.example.com', '/search', [{ name: 'q', value: 'a&b=c d' }])).toBe('https://api.example.com/search?q=a%26b%3Dc+d');
  });

  it('lets a later param replace an earlier one of the same name', () => {
    const url = endpointUrl('https://api.example.com', '/users', [
      { name: 'tenant', value: 'connection' },
      { name: 'status', value: 'active' },
      { name: 'tenant', value: 'endpoint' },
    ]);
    expect(url).toBe('https://api.example.com/users?tenant=endpoint&status=active');
  });

  it('keeps a query written in the path, which params can replace', () => {
    expect(endpointUrl('https://api.example.com', '/users?sort=name&x=1', [{ name: 'x', value: '2' }])).toBe('https://api.example.com/users?sort=name&x=2');
  });
});

describe('sameOrigin', () => {
  it('compares scheme, host and port', () => {
    expect(sameOrigin('https://api.example.com/a', 'https://api.example.com/b?page=2')).toBe(true);
    expect(sameOrigin('https://api.example.com', 'http://api.example.com')).toBe(false);
    expect(sameOrigin('https://api.example.com', 'https://api.example.com:8443')).toBe(false);
    expect(sameOrigin('https://api.example.com', 'https://evil.example.com')).toBe(false);
  });

  it('is false when either side is not a URL', () => {
    expect(sameOrigin('https://api.example.com', '/relative')).toBe(false);
  });
});

describe('unsafeIntegerIn', () => {
  it('finds the first whole number beyond 2^53 - 1, as written, including 2^53 itself and negatives', () => {
    expect(unsafeIntegerIn('[{"id":1},{"id":9007199254740993},{"id":9007199254740994}]')).toBe('9007199254740993');
    expect(unsafeIntegerIn('{"id":9007199254740992}')).toBe('9007199254740992');
    expect(unsafeIntegerIn('{"id":-9007199254740992}')).toBe('-9007199254740992');
    expect(unsafeIntegerIn('123456789012345678901234567890')).toBe('123456789012345678901234567890');
  });

  it('leaves exact whole numbers, decimals, exponents and digits in strings alone', () => {
    expect(unsafeIntegerIn('{"max":9007199254740991,"min":-9007199254740991}')).toBeUndefined();
    expect(unsafeIntegerIn('{"f":12345678901234567.5,"e":1e300,"g":1234567890123456789e2}')).toBeUndefined();
    expect(unsafeIntegerIn('{"id":"9007199254740993","q":"a\\"9007199254740993","9007199254740993":true}')).toBeUndefined();
  });
});

describe('isSendableHeaderValue', () => {
  it('accepts visible ASCII, spaces, tabs and Latin-1, and refuses control characters and anything beyond Latin-1', () => {
    expect(isSendableHeaderValue('Bearer abc.DEF-123_~+/=')).toBe(true);
    expect(isSendableHeaderValue('caf\u00e9\tok \u00ff')).toBe(true);
    for (const bad of ['a\r\nb', 'a\nb', 'a\u0000b', 'a\u001fb', 'a\u007fb', '\u20ac', '\u{1F600}']) {
      expect(isSendableHeaderValue(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('page planning', () => {
  it('sends connection params, then endpoint params, then page params, the most specific winning', () => {
    const config = makeConfig(
      { query: [{ name: 'limit', value: '5' }, { name: 'status', value: 'active' }], pagination: { type: 'offset', limit: 50 } },
      { query: [{ name: 'tenant', value: 'acme' }, { name: 'status', value: 'all' }] },
    );
    expect(firstPage(config, config.endpoints[0]).url).toBe('https://api.example.com/v2/users?tenant=acme&status=active&limit=50&offset=0');
  });

  it('makes one request without pagination', () => {
    expect(plan({ type: 'none' }, [fetched(10), fetched(10)])).toEqual(['https://api.example.com/v2/users']);
  });

  it('counts pages from the first page number until an empty page', () => {
    expect(plan({ type: 'page', firstPage: 0 }, [fetched(3), fetched(1), fetched(0)])).toEqual([
      'https://api.example.com/v2/users?page=0',
      'https://api.example.com/v2/users?page=1',
      'https://api.example.com/v2/users?page=2',
    ]);
  });

  it('sends the page size and keeps asking after a short page, stopping only at an empty one', () => {
    expect(plan({ type: 'page', size: { param: 'per_page', value: 2 } }, [fetched(2), fetched(1), fetched(0)])).toEqual([
      'https://api.example.com/v2/users?page=1&per_page=2',
      'https://api.example.com/v2/users?page=2&per_page=2',
      'https://api.example.com/v2/users?page=3&per_page=2',
    ]);
  });

  it('keeps asking for pages without a size, even after a short page', () => {
    expect(plan({ type: 'page' }, [fetched(5), fetched(1)])).toEqual([
      'https://api.example.com/v2/users?page=1',
      'https://api.example.com/v2/users?page=2',
      'then https://api.example.com/v2/users?page=3',
    ]);
  });

  it('moves the offset by the items received and stops only at an empty page', () => {
    expect(plan({ type: 'offset', limit: 2 }, [fetched(2), fetched(3), fetched(1), fetched(0)])).toEqual([
      'https://api.example.com/v2/users?offset=0&limit=2',
      'https://api.example.com/v2/users?offset=2&limit=2',
      'https://api.example.com/v2/users?offset=5&limit=2',
      'https://api.example.com/v2/users?offset=6&limit=2',
    ]);
  });

  it('sends the cursor found in the body and stops when it is missing, null or empty', () => {
    const pagination = { type: 'cursor', cursorPath: 'meta.next', cursorParam: 'after' };
    expect(plan(pagination, [fetched(1, { meta: { next: 'abc' } }), fetched(1, { meta: { next: 7 } }), fetched(1, { meta: { next: null } })])).toEqual([
      'https://api.example.com/v2/users',
      'https://api.example.com/v2/users?after=abc',
      'https://api.example.com/v2/users?after=7',
    ]);
    expect(plan(pagination, [fetched(1, { meta: {} })])).toHaveLength(1);
    expect(plan(pagination, [fetched(1, { meta: { next: '' } })])).toHaveLength(1);
  });

  it('returns the cursor value so the connector can refuse a repeated one', () => {
    const { config, endpoint } = setup({ type: 'cursor', cursorPath: 'next', cursorParam: 'c' });
    const first = firstPage(config, endpoint);
    expect(first).toMatchObject({ type: 'cursor', cursor: null });
    expect(nextPage(config, endpoint, first, fetched(1, { next: 'x1' }))).toMatchObject({ type: 'cursor', cursor: 'x1' });
  });

  it('refuses a cursor that is an object', () => {
    const { config, endpoint } = setup({ type: 'cursor', cursorPath: 'next', cursorParam: 'c' });
    expect(() => nextPage(config, endpoint, firstPage(config, endpoint), fetched(1, { next: { id: 1 } }))).toThrow(
      new ValidationError('Cursor field "next" holds an object, not text or a number'),
    );
  });

  it('follows a next URL from the body, resolving a relative one, without checking its origin', () => {
    const pagination = { type: 'nextUrl', nextUrlPath: 'links.next' };
    expect(
      plan(pagination, [
        fetched(1, { links: { next: '/v2/users?cursor=2' } }),
        fetched(1, { links: { next: 'https://other.example.com/users?cursor=3' } }),
        fetched(1, { links: { next: null } }),
      ]),
    ).toEqual(['https://api.example.com/v2/users', 'https://api.example.com/v2/users?cursor=2', 'https://other.example.com/users?cursor=3']);
  });

  it('refuses a next URL that is not text, and one that cannot be read, without quoting it', () => {
    const { config, endpoint } = setup({ type: 'nextUrl', nextUrlPath: 'next' });
    const first = firstPage(config, endpoint);
    expect(() => nextPage(config, endpoint, first, fetched(1, { next: 42 }))).toThrow('Next-page URL field "next" holds a number, not a URL');
    expect(() => nextPage(config, endpoint, first, fetched(1, { next: 'http://[bad?key=s3cret' }))).toThrow(/^Next-page URL field "next" is not a URL$/);
  });

  it('follows the Link header named by the endpoint', () => {
    const link = '<https://api.example.com/v2/users?page=2>; rel="next", <https://api.example.com/v2/users?page=9>; rel="last"';
    expect(plan({ type: 'linkHeader' }, [fetched(1, {}, { Link: link }), fetched(1, {}, {})])).toEqual([
      'https://api.example.com/v2/users',
      'https://api.example.com/v2/users?page=2',
    ]);
    expect(plan({ type: 'linkHeader', header: 'X-Next' }, [fetched(1, {}, { 'X-Next': '</v2/users?p=2>; rel=next' })])).toEqual([
      'https://api.example.com/v2/users',
      'then https://api.example.com/v2/users?p=2',
    ]);
  });

  it('stops page and offset mode at an empty page', () => {
    for (const pagination of [{ type: 'page' }, { type: 'offset' }]) {
      expect(plan(pagination, [fetched(0)]), pagination.type).toHaveLength(1);
    }
  });

  it('follows a named next page past an empty page in cursor, next-URL and Link mode', () => {
    const empty = fetched(0, { next: 'https://api.example.com/v2/users?page=2' }, { Link: '<https://api.example.com/v2/users?page=2>; rel="next"' });
    expect(plan({ type: 'cursor', cursorPath: 'next', cursorParam: 'c' }, [empty])).toEqual([
      'https://api.example.com/v2/users',
      'then https://api.example.com/v2/users?c=https%3A%2F%2Fapi.example.com%2Fv2%2Fusers%3Fpage%3D2',
    ]);
    for (const pagination of [{ type: 'nextUrl', nextUrlPath: 'next' }, { type: 'linkHeader' }]) {
      expect(plan(pagination, [empty]), pagination.type).toEqual(['https://api.example.com/v2/users', 'then https://api.example.com/v2/users?page=2']);
    }
    expect(plan({ type: 'cursor', cursorPath: 'next', cursorParam: 'c' }, [fetched(0)])).toHaveLength(1);
  });
});

describe('parseLinkNext', () => {
  it('finds the next link among several', () => {
    expect(parseLinkNext('<https://a.example/1>; rel="prev", <https://a.example/3>; rel="next"')).toBe('https://a.example/3');
  });

  it('reads unquoted rels, rel lists and extra whitespace', () => {
    expect(parseLinkNext('<https://a.example/2>;rel=next')).toBe('https://a.example/2');
    expect(parseLinkNext('  < https://a.example/2 > ;  title="a, b" ; rel = "next last" ')).toBe('https://a.example/2');
    expect(parseLinkNext('<https://a.example/2>; rel="NEXT"')).toBe('https://a.example/2');
  });

  it('ignores rels that only contain the word next', () => {
    expect(parseLinkNext('<https://a.example/2>; rel="nextpage"')).toBeUndefined();
  });

  it('is undefined without a next link or header', () => {
    expect(parseLinkNext('<https://a.example/1>; rel="prev"')).toBeUndefined();
    expect(parseLinkNext('')).toBeUndefined();
    expect(parseLinkNext(null)).toBeUndefined();
  });
});

describe('retryAfterMs', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');

  it('reads delay seconds', () => {
    expect(retryAfterMs('120', now)).toBe(120_000);
    expect(retryAfterMs(' 0 ', now)).toBe(0);
  });

  it('reads an HTTP date as the time left until it', () => {
    expect(retryAfterMs('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30_000);
    // The obsolete asctime format, still allowed by RFC 9110.
    expect(retryAfterMs('Thu Jan  1 00:01:00 2026', now)).toBeDefined();
  });

  it('gives 0 for a date already past', () => {
    expect(retryAfterMs('Wed, 31 Dec 2025 23:59:00 GMT', now)).toBe(0);
  });

  it('is undefined for a missing or unreadable value', () => {
    expect(retryAfterMs(null, now)).toBeUndefined();
    expect(retryAfterMs('', now)).toBeUndefined();
    expect(retryAfterMs('soon', now)).toBeUndefined();
    expect(retryAfterMs('-5', now)).toBeUndefined();
    expect(retryAfterMs('1.5', now)).toBeUndefined();
    expect(retryAfterMs('Someday', now)).toBeUndefined();
  });
});

describe('rateLimitHeaders', () => {
  it('keeps X-RateLimit-*, RateLimit, RateLimit-* and Retry-After, in order', () => {
    const headers: Array<[string, string]> = [
      ['content-type', 'application/json'],
      ['ratelimit', 'limit=100, remaining=50'],
      ['ratelimit-policy', '100;w=60'],
      ['retry-after', '5'],
      ['x-ratelimit-remaining', '49'],
      ['x-ratelimited', 'no'],
    ];
    expect(rateLimitHeaders(headers)).toEqual([
      { name: 'ratelimit', value: 'limit=100, remaining=50' },
      { name: 'ratelimit-policy', value: '100;w=60' },
      { name: 'retry-after', value: '5' },
      { name: 'x-ratelimit-remaining', value: '49' },
    ]);
  });

  it('cuts long values to 100 characters', () => {
    expect(rateLimitHeaders([['X-RateLimit-Policy', 'x'.repeat(150)]])[0].value).toHaveLength(100);
  });
});

describe('findArrayPaths', () => {
  it('reports a body that is a list of objects as $', () => {
    expect(findArrayPaths([{ id: 1, name: 'a' }, { id: 2 }])).toEqual([{ path: '$', items: 2, keys: ['id', 'name'] }]);
  });

  it('finds lists of objects and empty lists under objects, in document order', () => {
    const body = { meta: { tags: ['a'] }, data: { items: [{ id: 1 }], archived: [] }, errors: [] };
    expect(findArrayPaths(body)).toEqual([
      { path: 'data.items', items: 1, keys: ['id'] },
      { path: 'data.archived', items: 0, keys: [] },
      { path: 'errors', items: 0, keys: [] },
    ]);
  });

  it('skips lists of scalars and lists that mix objects with other values', () => {
    expect(findArrayPaths({ ids: [1, 2], mixed: [{ id: 1 }, 'x'], nested: [[{ id: 1 }]] })).toEqual([]);
    expect(findArrayPaths([1, 2])).toEqual([]);
  });

  it('looks up to four keys deep', () => {
    const body = { a: { b: { c: { d: [{ id: 1 }], e: { f: [{ id: 2 }] } } } } };
    expect(findArrayPaths(body).map((found) => found.path)).toEqual(['a.b.c.d']);
  });

  it('does not look inside lists', () => {
    expect(findArrayPaths({ pages: [{ items: [{ id: 1 }] }] }).map((found) => found.path)).toEqual(['pages']);
  });

  it('skips keys a data path cannot name', () => {
    expect(findArrayPaths({ 'a.b': [{ id: 1 }], $items: [{ id: 2 }], ok: [{ id: 3 }] }).map((found) => found.path)).toEqual(['ok']);
  });

  it('finds nothing in a scalar body', () => {
    expect(findArrayPaths('hello')).toEqual([]);
    expect(findArrayPaths(null)).toEqual([]);
  });
});

describe('itemsAt', () => {
  it('reads the whole body for $', () => {
    expect(itemsAt([{ id: 1 }], '$')).toEqual([{ id: 1 }]);
  });

  it('reads a nested list by its dotted path', () => {
    expect(itemsAt({ data: { items: [{ id: 1 }, { id: 2 }] } }, 'data.items')).toEqual([{ id: 1 }, { id: 2 }]);
    expect(itemsAt({ data: { items: [] } }, 'data.items')).toEqual([]);
  });

  it('refuses a path that is missing or holds no list', () => {
    expect(() => itemsAt({ data: {} }, 'data.items')).toThrow(new ValidationError('Data path "data.items" is not in the response'));
    expect(() => itemsAt({ data: { id: 1 } }, 'data')).toThrow('Data path "data" holds an object, not a list of items');
    expect(() => itemsAt({ data: null }, 'data')).toThrow('Data path "data" holds null, not a list of items');
  });

  it('refuses an item that is not an object, naming the path and the item without quoting it', () => {
    let error: unknown;
    try {
      itemsAt({ data: [{ id: 1 }, 'secret customer note'] }, 'data');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toBe('Data path "data": item 2 is text, not an object; each item must be an object to become a row');
  });
});

describe('maskedUrl', () => {
  const apiKeyQuery = { type: 'apiKeyQuery', param: 'api_key' } as const;

  it('hides the API key query parameter value', () => {
    expect(maskedUrl('https://api.example.com/users?page=2&api_key=s3cr3t', apiKeyQuery)).toBe('https://api.example.com/users?page=2&api_key=***');
  });

  it('leaves URLs without the key, or with another auth type, as they are', () => {
    expect(maskedUrl('https://api.example.com/users?page=2', apiKeyQuery)).toBe('https://api.example.com/users?page=2');
    expect(maskedUrl('https://api.example.com/users?api_key=x', { type: 'bearer' })).toBe('https://api.example.com/users?api_key=x');
  });

  it('shows nothing of a URL it cannot read', () => {
    expect(maskedUrl('not a url api_key=s3cr3t', apiKeyQuery)).toBe('(not a valid URL)');
  });
});

describe('describeHttpRead', () => {
  it('shows the first request, its headers, pagination, items, filters and limit', () => {
    const config = makeConfig(
      { dataPath: 'data.items', pagination: { type: 'page', size: { param: 'per_page', value: 50 } } },
      { auth: { type: 'bearer' }, secret: SECRET, headers: [{ name: 'X-Tenant', value: 'acme' }], minIntervalSeconds: 2 },
    );
    expect(
      describeHttpRead({ config, endpoint: config.endpoints[0], filters: [{ field: 'status', op: 'eq', value: 'paid' }, { field: 'n', op: 'ne', value: 3 }], limit: 10 }),
    ).toBe(
      [
        'GET https://api.example.com/v2/users?page=1&per_page=50',
        'Accept: application/json',
        'Authorization: Bearer ***',
        'X-Tenant: acme',
        'At most one request every 2 s to this API',
        'Pages: page=1, 2, ..., per_page=50; stops at an empty page',
        'Items: data.items',
        'Keeping items where status = "paid" and (n is empty or n != 3)',
        'First 10 items, then no more requests',
      ].join('\n'),
    );
  });

  it('masks every auth type and never shows the secret', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ type: 'basic', username: 'sync' }, 'Authorization: Basic sync:***'],
      [{ type: 'apiKeyHeader', header: 'X-API-Key' }, 'X-API-Key: ***'],
      [{ type: 'apiKeyQuery', param: 'api_key' }, 'GET https://api.example.com/v2/users?api_key=***'],
    ];
    for (const [auth, expected] of cases) {
      const config = makeConfig({}, { auth, secret: SECRET });
      const text = describeHttpRead({ config, endpoint: config.endpoints[0] });
      expect(text).toContain(expected);
      expect(text).not.toContain(SECRET);
    }
  });

  it('sends the API key after every other param, so a param of the same name cannot replace it', () => {
    const config = makeConfig({ query: [{ name: 'api_key', value: 'from-endpoint' }] }, { auth: { type: 'apiKeyQuery', param: 'api_key' }, secret: 'k' });
    expect(describeHttpRead({ config, endpoint: config.endpoints[0] })).toContain('GET https://api.example.com/v2/users?api_key=***\n');
  });

  it('describes each pagination mode', () => {
    const describe = (pagination: Record<string, unknown>) => {
      const { config, endpoint } = setup(pagination);
      return describeHttpRead({ config, endpoint }).split('\n').find((line) => line.startsWith('Pages:'));
    };
    expect(describe({ type: 'none' })).toBe('Pages: one request');
    expect(describe({ type: 'offset', limit: 20 })).toBe('Pages: offset=0, then by items received, limit=20; stops at an empty page');
    expect(describe({ type: 'cursor', cursorPath: 'meta.next', cursorParam: 'after' })).toBe('Pages: after=<cursor> from response field meta.next; stops when the field is empty');
    expect(describe({ type: 'nextUrl', nextUrlPath: 'links.next' })).toBe('Pages: next URL from response field links.next (same origin only); stops when the field is empty');
    expect(describe({ type: 'linkHeader' })).toBe('Pages: rel="next" link of the Link header (same origin only); stops when there is no next link');
  });
});

describe('describeHttpKeyLookup', () => {
  it('describes fetching every page once and matching the keys, auth masked', () => {
    const config = makeConfig({}, { auth: { type: 'bearer' }, secret: SECRET });
    const text = describeHttpKeyLookup(config, config.endpoints[0], ['id'], [{ id: 1 }, { id: 'b' }]);
    expect(text.split('\n')).toEqual([
      'GET https://api.example.com/v2/users',
      'Accept: application/json',
      'Authorization: Bearer ***',
      'Pages: one request',
      'Items: the whole body ($)',
      'Fetch every page and index the items by id (once per run), then match 2 keys: 1, "b"',
    ]);
    expect(text).not.toContain(SECRET);
  });

  it('shows composite keys in brackets', () => {
    const config = makeConfig();
    expect(describeHttpKeyLookup(config, config.endpoints[0], ['a', 'b'], [{ a: 1, b: 2 }])).toContain('match 1 key: (1, 2)');
  });
});

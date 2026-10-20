import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../src/common/errors';
import {
  ConnectionConfig,
  HTTP_MAX_RESPONSE_DEFAULT_BYTES,
  connectionConfigSchema,
  connectorConfigSchema,
  httpSecretProblem,
  keepsSavedSecret,
  secretRequired,
} from '../src/connections/connection.model';
import { ConnectionsRepository } from '../src/connections/connections.repository';
import { ConnectionsService } from '../src/connections/connections.service';
import { CsvFileStore } from '../src/connections/csv-file-store';
import { ConnectorFactory } from '../src/connectors/connector.factory';
import { SettingsRepository } from '../src/settings/settings.repository';
import { SettingsService } from '../src/settings/settings.service';
import { SecretBox } from '../src/storage/secret-box';
import { Workspace } from '../src/storage/workspace';

/** A valid HTTP API config, with `overrides` on top. */
function httpInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'http', baseUrl: 'https://api.example.com/v2', endpoints: [{ name: 'users', path: '/users' }], ...overrides };
}

/** The messages of a failed parse, each prefixed with its path, or [] when it parsed. */
function problems(input: Record<string, unknown>): string[] {
  const result = connectionConfigSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

function http(overrides: Record<string, unknown> = {}): ConnectionConfig {
  return connectionConfigSchema.parse(httpInput(overrides));
}

describe('HTTP API connection settings', () => {
  it('fills defaults for a minimal API', () => {
    expect(http()).toEqual({
      kind: 'http',
      baseUrl: 'https://api.example.com/v2',
      auth: { type: 'none' },
      secret: '',
      headers: [],
      query: [],
      minIntervalSeconds: 0,
      endpoints: [{ name: 'users', path: '/users', query: [], dataPath: '$', pagination: { type: 'none' } }],
    });
  });

  it('fills the defaults of each pagination mode', () => {
    const endpoint = (pagination: Record<string, unknown>) =>
      (http({ endpoints: [{ name: 'users', path: '/users', pagination }] }) as Extract<ConnectionConfig, { kind: 'http' }>).endpoints[0].pagination;
    expect(endpoint({ type: 'page' })).toEqual({ type: 'page', pageParam: 'page', firstPage: 1 });
    expect(endpoint({ type: 'offset' })).toEqual({ type: 'offset', offsetParam: 'offset', limitParam: 'limit', limit: 100 });
    expect(endpoint({ type: 'linkHeader' })).toEqual({ type: 'linkHeader', header: 'Link' });
    expect(problems(httpInput({ endpoints: [{ name: 'u', path: '/u', pagination: { type: 'cursor', cursorPath: '$next', cursorParam: 'c' } }] }))).toHaveLength(1);
    expect(problems(httpInput({ endpoints: [{ name: 'u', path: '/u', pagination: { type: 'page', size: { param: 'per_page', value: 10_001 } } }] }))).toHaveLength(1);
  });

  it('refuses a base URL with a query string, pointing to the Query params list', () => {
    expect(problems(httpInput({ baseUrl: 'https://api.example.com/v2?tenant=7' }))).toEqual([
      "baseUrl: Remove the ?query: put query parameters in the connection's Query params list",
    ]);
    expect(problems(httpInput({ baseUrl: 'https://api.example.com/v2?' }))).toHaveLength(1);
  });

  it('refuses a base URL with credentials, a fragment or another protocol', () => {
    expect(problems(httpInput({ baseUrl: 'https://sync:hunter2@api.example.com' }))).toEqual(['baseUrl: Put credentials under Authentication, not in the URL']); // secret-scan: allow
    expect(problems(httpInput({ baseUrl: 'https://api.example.com/v2#top' }))).toEqual(['baseUrl: Remove the #fragment: it is never sent to the server']);
    expect(problems(httpInput({ baseUrl: 'https://api.example.com/#' }))).toHaveLength(1);
    expect(problems(httpInput({ baseUrl: 'ftp://api.example.com' }))).toEqual(['baseUrl: Must start with http:// or https://']);
    expect(problems(httpInput({ baseUrl: 'api.example.com' }))).toEqual(['baseUrl: Must be a URL such as https://api.example.com/v2']);
    expect(problems(httpInput({ baseUrl: 'http://localhost:8080' }))).toEqual([]);
  });

  it('refuses credential headers and Host, in any case, in headers and as the API key header', () => {
    for (const name of ['Authorization', 'cookie', 'Proxy-Authorization', 'HOST']) {
      expect(problems(httpInput({ headers: [{ name, value: 'x' }] }))).toHaveLength(1);
      expect(problems(httpInput({ auth: { type: 'apiKeyHeader', header: name } }))).toHaveLength(1);
    }
    expect(problems(httpInput({ headers: [{ name: 'X-Tenant', value: 'acme' }], auth: { type: 'apiKeyHeader', header: 'X-API-Key' } }))).toEqual([]);
  });

  it('refuses malformed header and parameter names, and header values with line breaks', () => {
    expect(problems(httpInput({ headers: [{ name: 'X Tenant', value: 'acme' }] }))).toHaveLength(1);
    expect(problems(httpInput({ headers: [{ name: 'X-Tenant', value: 'acme\r\nX-Evil: 1' }] }))).toEqual(['headers.0.value: Must be on one line']);
    expect(problems(httpInput({ query: [{ name: 'a&b', value: '1' }] }))).toHaveLength(1);
    expect(problems(httpInput({ auth: { type: 'apiKeyQuery', param: 'api key' } }))).toHaveLength(1);
    expect(problems(httpInput({ headers: Array.from({ length: 21 }, (_, i) => ({ name: `X-${i}`, value: '' })) }))).toHaveLength(1);
  });

  it('refuses duplicate endpoint names and points at the second one', () => {
    const endpoints = [
      { name: 'users', path: '/users' },
      { name: 'users', path: '/v1/users' },
    ];
    expect(problems(httpInput({ endpoints }))).toEqual(['endpoints.1.name: Another endpoint is already named "users"']);
    expect(problems(httpInput({ endpoints: [] }))).toEqual(['endpoints: Add at least one endpoint']);
  });

  it('accepts relative endpoint paths only', () => {
    const path = (value: string) => problems(httpInput({ endpoints: [{ name: 'users', path: value }] }));
    expect(path('/users?active=true')).toEqual([]);
    expect(path('/')).toEqual([]);
    for (const bad of ['users', '//evil.example.com/users', '/users#top', '/my users', 'https://api.example.com/users']) {
      expect(path(bad)).toHaveLength(1);
    }
  });

  it('refuses header values an HTTP header cannot carry, without quoting them', () => {
    const value = (text: string) => problems(httpInput({ headers: [{ name: 'X-Tenant', value: text }] }));
    const message = 'headers.0.value: Use only characters an HTTP header can carry: no control characters, nothing beyond Latin-1';
    expect(value('acme\u0000')).toEqual([message]);
    expect(value('a\u0001b')).toEqual([message]);
    expect(value('a\u007fb')).toEqual([message]);
    expect(value('caf\u00e9 \u20ac')).toEqual([message]);
    expect(value('tenant\tcafé ~!')).toEqual([]);
  });

  it('refuses a blank or missing number instead of reading it as 0', () => {
    expect(problems(httpInput({ minIntervalSeconds: null }))).toEqual(['minIntervalSeconds: Enter a number of seconds']);
    expect(problems(httpInput({ minIntervalSeconds: '' }))).toEqual(['minIntervalSeconds: Enter a number of seconds']);
    const pagination = (value: Record<string, unknown>) => problems(httpInput({ endpoints: [{ name: 'users', path: '/users', pagination: value }] }));
    expect(pagination({ type: 'page', firstPage: null })).toEqual(['endpoints.0.pagination.firstPage: Enter the number of the first page']);
    expect(pagination({ type: 'page', size: { param: 'per_page', value: '' } })).toEqual(['endpoints.0.pagination.size.value: Enter a page size']);
    expect(pagination({ type: 'offset', limit: null })).toEqual(['endpoints.0.pagination.limit: Enter a page size']);
    expect(pagination({ type: 'offset', limit: 2.5 })).toEqual(['endpoints.0.pagination.limit: Use a whole number']);
    // Saved connections hold numbers, which still parse.
    expect(pagination({ type: 'page', firstPage: 0, size: { param: 'per_page', value: 50 } })).toEqual([]);
    expect(problems(httpInput({ minIntervalSeconds: 1.5 }))).toEqual([]);
  });

  it('checks endpoint names and data paths', () => {
    const endpoint = (fields: Record<string, unknown>) => problems(httpInput({ endpoints: [{ name: 'users', path: '/users', ...fields }] }));
    expect(endpoint({ name: '-users' })).toHaveLength(1);
    expect(endpoint({ name: 'a'.repeat(61) })).toHaveLength(1);
    expect(endpoint({ dataPath: 'data.items' })).toEqual([]);
    expect(endpoint({ dataPath: '__proto__.x' })).toHaveLength(1);
    expect(endpoint({ dataPath: '$.data' })).toHaveLength(1);
  });

  it('opens a connector with the default response limit when none is given', () => {
    const config = connectorConfigSchema.parse(httpInput());
    expect(config.kind === 'http' && config.maxResponseBytes).toBe(HTTP_MAX_RESPONSE_DEFAULT_BYTES);
  });
});

describe('secrets of HTTP API connections', () => {
  it('requires a secret for every auth type except none', () => {
    expect(secretRequired('http', 'none')).toBe(false);
    expect(secretRequired('http')).toBe(false);
    expect(secretRequired('http', 'bearer')).toBe(true);
    expect(secretRequired('http', 'basic')).toBe(true);
    expect(secretRequired('http', 'apiKeyHeader')).toBe(true);
    expect(secretRequired('http', 'apiKeyQuery')).toBe(true);
    expect(secretRequired('mongo')).toBe(true);
    expect(secretRequired('postgres')).toBe(false);
  });

  it('keeps a saved secret on a blank edit only while the kind and auth type stay the same', () => {
    const savedBearer = http({ auth: { type: 'bearer' }, secret: 'saved' });
    expect(keepsSavedSecret(http({ auth: { type: 'bearer' } }), savedBearer)).toBe(true);
    expect(keepsSavedSecret(http({ auth: { type: 'bearer' }, secret: 'new' }), savedBearer)).toBe(false);
    expect(keepsSavedSecret(http({ auth: { type: 'apiKeyHeader', header: 'X-API-Key' } }), savedBearer)).toBe(false);
    expect(keepsSavedSecret(http({ auth: { type: 'none' } }), http({ auth: { type: 'none' } }))).toBe(false);

    const savedMongo = connectionConfigSchema.parse({ kind: 'mongo', uri: 'mongodb://saved', database: 'crm' });
    expect(keepsSavedSecret(connectionConfigSchema.parse({ kind: 'mongo', uri: '', database: 'crm' }), savedMongo)).toBe(true);
    expect(keepsSavedSecret(http({ auth: { type: 'bearer' } }), savedMongo)).toBe(false);
  });

  it('asks for the secret again when the base URL moves to another origin', () => {
    const saved = http({ baseUrl: 'https://api.example.com/v2', auth: { type: 'bearer' }, secret: 'saved' });
    const blankAt = (baseUrl: string) => keepsSavedSecret(http({ baseUrl, auth: { type: 'bearer' } }), saved);
    expect(blankAt('https://api.example.com/v3')).toBe(true);
    expect(blankAt('https://API.example.com:443/v2')).toBe(true);
    expect(blankAt('https://other.example.com/v2')).toBe(false);
    expect(blankAt('http://api.example.com/v2')).toBe(false);
    expect(blankAt('https://api.example.com:8443/v2')).toBe(false);
  });

  it('refuses a token that cannot travel in a header, without quoting it', () => {
    const message = 'The token contains characters that cannot be sent in an HTTP header (a line break, a control character or one beyond Latin-1); paste it again';
    expect(httpSecretProblem({ type: 'bearer' }, 'tok\nen')).toBe(message);
    expect(httpSecretProblem({ type: 'apiKeyHeader', header: 'X-API-Key' }, 'k\u0000ey')).toBe(message.replace('token', 'API key'));
    expect(httpSecretProblem({ type: 'bearer' }, 'tok\u20acen')).toBe(message);
    expect(httpSecretProblem({ type: 'bearer' }, 'tok-123_ABC.xyz=')).toBeUndefined();
    // Basic auth and query keys are encoded before sending, so any text can be sent.
    expect(httpSecretProblem({ type: 'basic', username: 'sync' }, 'pässwörd\u20ac')).toBeUndefined();
    expect(httpSecretProblem({ type: 'apiKeyQuery', param: 'key' }, 'a b&c\u20ac')).toBeUndefined();
  });
});

describe('ConnectionsService with HTTP API connections', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function service() {
    const root = await mkdtemp(join(tmpdir(), 'syncforge-http-'));
    dirs.push(root);
    const workspace = new Workspace(root);
    const settings = new SettingsService(new SettingsRepository(workspace));
    const secrets = await SecretBox.load(join(root, 'secret.key'));
    const store = new CsvFileStore(workspace, settings);
    return new ConnectionsService(new ConnectionsRepository(workspace.local('connections')), secrets, new ConnectorFactory(), store, settings);
  }

  it('summarizes an API, refuses a missing token and clears the secret when auth is switched off', async () => {
    const connections = await service();
    await expect(connections.create({ name: 'Users API', config: http({ auth: { type: 'bearer' } }) })).rejects.toThrow('config.secret: Required');

    const created = await connections.create({ name: 'Users API', config: http({ auth: { type: 'bearer' }, secret: 'tok' }) });
    expect(created.summary).toBe('GET https://api.example.com/v2 · 1 endpoint · bearer');
    expect(created.hasSecret).toBe(true);
    expect(created.settings).not.toHaveProperty('secret');

    const kept = await connections.update(created.id, { name: 'Users API', config: http({ auth: { type: 'bearer' } }) });
    expect(kept.hasSecret).toBe(true);
    const switched = await connections.update(created.id, { name: 'Users API', config: http({ auth: { type: 'basic', username: 'sync' } }) }).catch((error: Error) => error);
    expect(switched).toBeInstanceOf(Error);
    expect((switched as Error).message).toBe('config.secret: Required');

    const moved = await connections.update(created.id, { name: 'Users API', config: http({ baseUrl: 'https://other.example.com/v2', auth: { type: 'bearer' } }) }).catch((error: Error) => error);
    expect((moved as Error).message).toBe('config.secret: Required');

    const off = await connections.update(created.id, { name: 'Users API', config: http({ auth: { type: 'none' }, secret: 'stale' }) });
    expect(off.hasSecret).toBe(false);
    expect((await connections.resolve(created.id)).config).toMatchObject({ secret: '' });
  });

  it('refuses to save a token that cannot be sent in a header, without quoting it', async () => {
    const connections = await service();
    const error = await connections.create({ name: 'Users API', config: http({ auth: { type: 'bearer' }, secret: 'tok-s3cret\n' }) }).catch((caught: Error) => caught); // secret-scan: allow
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toMatch(/^config\.secret: The token contains characters that cannot be sent in an HTTP header/);
    expect((error as Error).message).not.toContain('tok-s3cret');
  });

  it('tests an HTTP API connection with a request to its first endpoint', async () => {
    const connections = await service();
    // A port that was just free: nothing listens there, so the request is refused without leaving the machine.
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const result = await connections.test(http({ baseUrl: `http://127.0.0.1:${port}/v2` }));
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining(`Endpoint "users": GET http://127.0.0.1:${port}/v2/users failed: connection refused`) });
  });
});

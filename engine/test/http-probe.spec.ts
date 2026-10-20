import { mkdtemp, rm } from 'node:fs/promises';
import { IncomingHttpHeaders, Server, ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../src/common/errors';
import { HttpEndpoint, HttpProbeConfig, httpEndpointSchema, httpProbeConfigSchema } from '../src/connections/connection.model';
import { ConnectionsRepository } from '../src/connections/connections.repository';
import { ConnectionsService } from '../src/connections/connections.service';
import { CsvFileStore } from '../src/connections/csv-file-store';
import { ConnectorFactory } from '../src/connectors/connector.factory';
import { SettingsRepository } from '../src/settings/settings.repository';
import { SettingsService } from '../src/settings/settings.service';
import { SecretBox } from '../src/storage/secret-box';
import { Workspace } from '../src/storage/workspace';

/** Made-up credentials: no response may ever contain them. */
const TOKEN = 'tok-probe-s3cret-9'; // secret-scan: allow

type Handler = (url: URL, response: ServerResponse) => void;

interface Stub {
  base: string;
  requests: Array<{ path: string; headers: IncomingHttpHeaders }>;
}

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A stub API on 127.0.0.1 and a free port that records every request. */
async function stub(handler: Handler): Promise<Stub> {
  const requests: Stub['requests'] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://stub');
    requests.push({ path: `${url.pathname}${url.search}`, headers: request.headers });
    handler(url, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

function json(response: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

/** A users API: one page of two users, rate-limit headers, and 401 without the right bearer token. */
function usersApi(url: URL, response: ServerResponse, authorization: string | undefined): void {
  const rateLimit = { 'x-ratelimit-remaining': '41', 'x-ratelimit-limit': '60' };
  if (authorization !== `Bearer ${TOKEN}` && !url.searchParams.has('api_key')) return json(response, { error: 'no' }, 401, rateLimit);
  json(response, { data: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Linus' }], meta: { page: 1 } }, 200, rateLimit);
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'syncforge-probe-'));
  dirs.push(root);
  const workspace = new Workspace(root);
  const settings = new SettingsService(new SettingsRepository(workspace));
  const secrets = await SecretBox.load(join(root, 'secret.key'));
  const connections = new ConnectionsService(
    new ConnectionsRepository(workspace.local('connections')),
    secrets,
    new ConnectorFactory(),
    new CsvFileStore(workspace, settings),
    settings,
  );
  return { connections, settings };
}

function probeConfig(base: string, overrides: Record<string, unknown> = {}): HttpProbeConfig {
  return httpProbeConfigSchema.parse({ kind: 'http', baseUrl: `${base}/v2`, ...overrides });
}

function endpoint(overrides: Record<string, unknown> = {}): HttpEndpoint {
  return httpEndpointSchema.parse({ name: 'users', path: '/users', ...overrides });
}

describe('probing an HTTP API endpoint before it is saved', () => {
  it('shows the status, size, rate-limit headers and the arrays of objects in the body', async () => {
    const api = await stub((url, response) => usersApi(url, response, undefined));
    const { connections } = await setup();
    const result = await connections.probeHttpEndpoint(probeConfig(api.base, { auth: { type: 'apiKeyQuery', param: 'api_key' }, secret: TOKEN }), endpoint());

    expect(result).toMatchObject({
      status: 200,
      contentType: 'application/json',
      rateLimit: expect.arrayContaining([{ name: 'x-ratelimit-remaining', value: '41' }]),
      arrays: [{ path: 'data', items: 2, keys: ['id', 'name'] }],
      nextPage: null,
    });
    expect(result.bytes).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('shows a refused request with its status and rate-limit headers instead of failing', async () => {
    const api = await stub((url, response) => usersApi(url, response, undefined));
    const { connections } = await setup();
    const result = await connections.probeHttpEndpoint(probeConfig(api.base, { auth: { type: 'bearer' }, secret: 'wrong' }), endpoint());
    expect(result).toMatchObject({ status: 401, arrays: [], nextPage: null, rateLimit: expect.arrayContaining([{ name: 'x-ratelimit-limit', value: '60' }]) });
  });

  it('uses the saved token when the secret is left blank and the auth type is unchanged', async () => {
    const api = await stub((url, response) => usersApi(url, response, api.requests.at(-1)?.headers.authorization));
    const { connections } = await setup();
    const saved = await connections.create({
      name: 'Users API',
      config: { ...probeConfig(api.base, { auth: { type: 'bearer' }, secret: TOKEN }), endpoints: [endpoint()] },
    });

    const result = await connections.probeHttpEndpoint(probeConfig(api.base, { auth: { type: 'bearer' } }), endpoint({ dataPath: 'data' }), saved.id);
    expect(api.requests.map((request) => request.headers.authorization)).toEqual([`Bearer ${TOKEN}`]);
    expect(result.status).toBe(200);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('asks for the secret instead of sending the saved one as another kind of credential', async () => {
    const api = await stub((url, response) => usersApi(url, response, undefined));
    const { connections } = await setup();
    const saved = await connections.create({
      name: 'Users API',
      config: { ...probeConfig(api.base, { auth: { type: 'bearer' }, secret: TOKEN }), endpoints: [endpoint()] },
    });

    const error = await connections
      .probeHttpEndpoint(probeConfig(api.base, { auth: { type: 'apiKeyHeader', header: 'X-API-Key' } }), endpoint(), saved.id)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toBe('config.secret: Required');
    expect(api.requests).toEqual([]);
  });

  it('asks for the secret again when the base URL moves to another origin', async () => {
    const api = await stub((url, response) => usersApi(url, response, undefined));
    const other = await stub((url, response) => usersApi(url, response, undefined));
    const { connections } = await setup();
    const saved = await connections.create({
      name: 'Users API',
      config: { ...probeConfig(api.base, { auth: { type: 'bearer' }, secret: TOKEN }), endpoints: [endpoint()] },
    });
    const savedHttps = await connections.create({
      name: 'Users API over TLS',
      config: { ...probeConfig(api.base.replace('http:', 'https:'), { auth: { type: 'bearer' }, secret: TOKEN }), endpoints: [endpoint()] },
    });

    // Another port on the same host, and a downgrade from https to http on the same host and port.
    for (const [base, id] of [
      [other.base, saved.id],
      [api.base, savedHttps.id],
    ]) {
      const error = await connections.probeHttpEndpoint(probeConfig(base, { auth: { type: 'bearer' } }), endpoint(), id).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toBe('config.secret: Required');
    }
    expect(api.requests).toEqual([]);
    expect(other.requests).toEqual([]);
  });

  it('reads responses up to the size limit set in Settings', async () => {
    const api = await stub((_url, response) => json(response, [{ id: 1, text: 'x'.repeat(1024 * 1024 + 10) }]));
    const { connections, settings } = await setup();
    await settings.update({ ...(await settings.get()), httpMaxResponseMb: 1 });
    await expect(connections.probeHttpEndpoint(probeConfig(api.base), endpoint())).rejects.toThrow('larger than 1 MB, the response size limit');
  });
});

describe('testing an HTTP API connection', () => {
  it('reports the rate-limit headers of the request to the first endpoint', async () => {
    const api = await stub((url, response) => usersApi(url, response, api.requests.at(-1)?.headers.authorization));
    const { connections } = await setup();
    const result = await connections.test({ ...probeConfig(api.base, { auth: { type: 'bearer' }, secret: TOKEN }), endpoints: [endpoint()] });
    expect(result).toMatchObject({ ok: true, rateLimit: expect.arrayContaining([{ name: 'x-ratelimit-remaining', value: '41' }]) });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('fails a test on a refused request, without the token in the message', async () => {
    const api = await stub((url, response) => usersApi(url, response, undefined));
    const { connections } = await setup();
    const result = await connections.test({ ...probeConfig(api.base, { auth: { type: 'bearer' }, secret: TOKEN.slice(1) }), endpoints: [endpoint()] });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('HTTP 401 Unauthorized') });
    expect(JSON.stringify(result)).not.toContain(TOKEN.slice(1));
  });
});

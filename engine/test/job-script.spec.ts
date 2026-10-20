import { describe, expect, it } from 'vitest';
import { ConnectionView, connectionConfigSchema } from '../src/connections/connection.model';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConnectionsRepository } from '../src/connections/connections.repository';
import { ConnectionsService } from '../src/connections/connections.service';
import { CsvFileStore } from '../src/connections/csv-file-store';
import { ConnectorFactory } from '../src/connectors/connector.factory';
import { SettingsRepository } from '../src/settings/settings.repository';
import { SettingsService } from '../src/settings/settings.service';
import { SecretBox } from '../src/storage/secret-box';
import { Workspace } from '../src/storage/workspace';
import ts from 'typescript';
import { STANDALONE_MODULE, buildJobScript, scriptEnvField, secretEnvName } from '../src/jobs/job-script';
import { Job } from '../src/jobs/job.model';

function view(id: string, name: string, kind: ConnectionView['kind'], settings: Record<string, unknown>): ConnectionView {
  return { id, name, kind, summary: name, settings, hasSecret: true, createdAt: '', updatedAt: '' };
}

const job: Job = {
  id: 'orders-1a2b3c',
  name: 'Orders',
  source: { connectionId: 'legacy', collection: 'public.orders' },
  lookups: [{ as: 'customer', connectionId: 'crm', collection: 'customers', on: [{ source: 'customer_ref', lookup: 'customerRef' }], required: false }],
  target: { connectionId: 'newcore', collection: 'public.orders', keyFields: ['id'] },
  mappings: [{ from: 'order_no', to: 'id', transform: 'none' }],
  mode: 'full',
  batchSize: 500,
  errorPolicy: 'fail',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const connections = [
  view('legacy', 'Legacy PG', 'postgres', { kind: 'postgres', host: 'db.local', port: 5432, database: 'legacy', user: 'sync', ssl: 'disable' }),
  view('crm', 'Old CRM', 'mongo', { kind: 'mongo', database: 'crm' }),
  view('newcore', 'New core', 'postgres', { kind: 'postgres', host: 'db.local', port: 5432, database: 'newcore', user: 'sync', ssl: 'disable' }),
];

describe('job script export', () => {
  it('names one environment variable per secret', () => {
    expect(secretEnvName('Legacy PG', 'password')).toBe('LEGACY_PG_PASSWORD');
    expect(secretEnvName('old-crm (prod)', 'uri')).toBe('OLD_CRM_PROD_URI');
    expect(secretEnvName('1st db', 'key')).toBe('_1ST_DB_KEY');
  });

  it('writes the job, every connection without secrets, and reads each secret from the environment', () => {
    const { fileName, content } = buildJobScript(job, connections, '2026-10-10');

    expect(fileName).toBe('orders-1a2b3c.sync.ts');
    expect(content).toContain("import { env, optionalEnv, runFromCommandLine, type StandaloneDefinition } from 'sync-forge-engine/standalone';");
    expect(content).toContain('password: optionalEnv("LEGACY_PG_PASSWORD"),');
    expect(content).toContain('uri: env("OLD_CRM_URI"),');
    expect(content).toContain('password: optionalEnv("NEW_CORE_PASSWORD"),');
    expect(content).toContain('"host": "db.local",');
    expect(content).toContain('"customerRef"');
    expect(content).not.toContain('createdAt');
    expect(content).toContain('void runFromCommandLine(definition);');
  });

  it('imports the runner under the engine package\'s own name', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as { name: string };
    expect(STANDALONE_MODULE).toBe(`${pkg.name}/standalone`);
  });

  it('keeps environment variable names unique when connections share a name', () => {
    const twins = [view('a1', 'Shared', 'mongo', { kind: 'mongo', database: 'a' }), view('b2', 'Shared', 'mongo', { kind: 'mongo', database: 'b' })];
    const { content } = buildJobScript({ ...job, source: { connectionId: 'a1', collection: 'x' }, target: { ...job.target, connectionId: 'b2' }, lookups: undefined }, twins, '2026-10-10');
    expect(content).toContain('env("SHARED_URI")');
    expect(content).toContain('env("SHARED_B2_URI")');
  });

  it('reads the folder of a CSV connection from the environment and says files keep their uploaded names', () => {
    expect(scriptEnvField('csv', {})).toEqual({ field: 'directory', label: 'folder holding the CSV files', required: true });
    expect(scriptEnvField('postgres', {})).toEqual({ field: 'password', label: 'password', required: false });
    const withCsv = [view('uploads', 'Uploads', 'csv', { kind: 'csv', delimiter: ';' }), ...connections.slice(1)];
    const { content } = buildJobScript({ ...job, source: { connectionId: 'uploads', collection: 'orders.csv' } }, withCsv, '2026-10-10');

    expect(content).toContain('directory: env("UPLOADS_DIRECTORY"),');
    expect(content).toContain('"delimiter": ";",');
    expect(content).toMatch(/UPLOADS_DIRECTORY\s+folder holding the CSV files of "Uploads"\n/);
    expect(content).toContain('CSV files must keep the names they were uploaded with');
    expect(content).toContain('Secrets and CSV folders come from environment variables:');
    const { diagnostics } = ts.transpileModule(content, { reportDiagnostics: true });
    expect(diagnostics).toEqual([]);
  });

  it('leaves the CSV notes out of scripts for databases only', () => {
    const { content } = buildJobScript(job, connections, '2026-10-10');
    expect(content).not.toContain('CSV');
    expect(content).toContain(' Secrets come from environment variables:');
  });

  it('names the environment variable of an HTTP API after what its auth type sends', () => {
    const http = (auth: Record<string, unknown>) => ({ kind: 'http', baseUrl: 'https://api.example.com', auth, endpoints: [] });
    expect(scriptEnvField('http', http({ type: 'bearer' }))).toEqual({ field: 'secret', envSuffix: 'token', label: 'bearer token', required: true });
    expect(scriptEnvField('http', http({ type: 'basic', username: 'sync' }))).toEqual({ field: 'secret', envSuffix: 'password', label: 'password', required: true });
    expect(scriptEnvField('http', http({ type: 'apiKeyHeader', header: 'X-API-Key' }))).toMatchObject({ field: 'secret', envSuffix: 'key' });
    expect(scriptEnvField('http', http({ type: 'apiKeyQuery', param: 'api_key' }))).toMatchObject({ field: 'secret', envSuffix: 'key' });
    expect(scriptEnvField('http', http({ type: 'none' }))).toBeNull();
  });

  it('reads an HTTP API token from the environment, and writes an API without auth with no environment line', () => {
    const api = (id: string, name: string, auth: Record<string, unknown>) =>
      view(id, name, 'http', { kind: 'http', baseUrl: 'https://api.example.com/v2', auth, headers: [], query: [], minIntervalSeconds: 0, endpoints: [{ name: 'users', path: '/users' }] });
    const apis = [api('users-api', 'Users API', { type: 'bearer' }), api('geo', 'Geo', { type: 'none' }), connections[2]];
    const { content } = buildJobScript({ ...job, source: { connectionId: 'users-api', collection: 'users' }, lookups: [{ ...job.lookups![0], connectionId: 'geo' }] }, apis, '2026-10-10');

    expect(content).toContain('secret: env("USERS_API_TOKEN"),');
    expect(content).toMatch(/USERS_API_TOKEN\s+bearer token of "Users API"\n/);
    expect(content).toContain('"geo": {');
    expect(content).not.toContain('GEO_');
    const { diagnostics } = ts.transpileModule(content, { reportDiagnostics: true });
    expect(diagnostics).toEqual([]);
  });

  it('reads each HTTP API secret from an environment variable named for its auth type, and never writes the saved value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'syncforge-script-'));
    try {
      const workspace = new Workspace(root);
      const settings = new SettingsService(new SettingsRepository(workspace));
      const store = new ConnectionsService(
        new ConnectionsRepository(workspace.local('connections')),
        await SecretBox.load(join(root, 'secret.key')),
        new ConnectorFactory(),
        new CsvFileStore(workspace, settings),
        settings,
      );
      const save = (name: string, auth: Record<string, unknown>, secret: string) =>
        store.create({
          name,
          config: connectionConfigSchema.parse({ kind: 'http', baseUrl: 'https://api.example.com/v2', auth, secret, endpoints: [{ name: 'users', path: '/users' }] }),
        });
      const views = [
        await save('Users API', { type: 'basic', username: 'sync' }, 'pw-saved-111'), // secret-scan: allow
        await save('Geo API', { type: 'apiKeyQuery', param: 'api_key' }, 'key-saved-222'), // secret-scan: allow
        connections[2],
      ];
      const { content } = buildJobScript(
        { ...job, source: { connectionId: views[0].id, collection: 'users' }, lookups: [{ ...job.lookups![0], connectionId: views[1].id }] },
        views,
        '2026-10-10',
      );

      expect(content).toContain('secret: env("USERS_API_PASSWORD"),');
      expect(content).toContain('secret: env("GEO_API_KEY"),');
      expect(content).not.toContain('pw-saved-111');
      expect(content).not.toContain('key-saved-222');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stays valid TypeScript when a job or connection name contains a comment terminator', () => {
    const named = [view('legacy', 'Legacy */ PG', 'postgres', { kind: 'postgres', host: 'db.local', port: 5432, database: 'legacy', user: 'sync', ssl: 'disable' }), ...connections.slice(1)];
    const { content } = buildJobScript({ ...job, name: 'nightly */ copy' }, named, '2026-10-10');
    const { diagnostics } = ts.transpileModule(content, { reportDiagnostics: true });
    expect(diagnostics?.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
    expect(content).toContain('Syncforge job "nightly *\\/ copy"');
    expect(content).toContain('name: "Legacy */ PG",');
  });
});

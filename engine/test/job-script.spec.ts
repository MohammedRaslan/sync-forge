import { describe, expect, it } from 'vitest';
import { ConnectionView } from '../src/connections/connection.model';
import { buildJobScript, secretEnvName } from '../src/jobs/job-script';
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
    expect(content).toContain("import { env, optionalEnv, runFromCommandLine, type StandaloneDefinition } from 'syncforge-engine/standalone';");
    expect(content).toContain('password: optionalEnv("LEGACY_PG_PASSWORD"),');
    expect(content).toContain('uri: env("OLD_CRM_URI"),');
    expect(content).toContain('password: optionalEnv("NEW_CORE_PASSWORD"),');
    expect(content).toContain('"host": "db.local",');
    expect(content).toContain('"customerRef"');
    expect(content).not.toContain('createdAt');
    expect(content).toContain('void runFromCommandLine(definition);');
  });

  it('keeps environment variable names unique when connections share a name', () => {
    const twins = [view('a1', 'Shared', 'mongo', { kind: 'mongo', database: 'a' }), view('b2', 'Shared', 'mongo', { kind: 'mongo', database: 'b' })];
    const { content } = buildJobScript({ ...job, source: { connectionId: 'a1', collection: 'x' }, target: { ...job.target, connectionId: 'b2' }, lookups: undefined }, twins, '2026-10-10');
    expect(content).toContain('env("SHARED_URI")');
    expect(content).toContain('env("SHARED_B2_URI")');
  });
});

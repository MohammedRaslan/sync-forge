import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoClient } from 'mongodb';
import { Pool } from 'pg';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectionConfig, ConnectionView, SECRET_FIELD } from '../../src/connections/connection.model';
import { buildJobScript } from '../../src/jobs/job-script';
import { Job } from '../../src/jobs/job.model';
import { Started, startMongo, startPostgres } from './containers';

/**
 * The export as people use it: build the engine, export a job's script, and run it with Node from inside the
 * engine folder (the import resolves through the package's own "exports"), secrets passed as environment variables.
 */

const ENGINE_DIR = resolve(__dirname, '../..');
const WORK_DIR = resolve(ENGINE_DIR, '.script-test');

let postgres: Started<import('../../src/connections/connection.model').PostgresConfig>;
let mongo: Started<import('../../src/connections/connection.model').MongoConfig>;
let legacy: Pool;
let mongoClient: MongoClient;
let scriptPath: string;
let secrets: Record<string, string>;

function viewOf(id: string, name: string, config: ConnectionConfig): ConnectionView {
  const { [SECRET_FIELD[config.kind]]: _secret, ...settings } = config as Record<string, unknown>;
  return { id, name, kind: config.kind, summary: name, settings, hasSecret: true, createdAt: '', updatedAt: '' };
}

function runScript(args: string[] = [], env: Record<string, string> = secrets) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], { cwd: WORK_DIR, env: { ...process.env, ...env }, encoding: 'utf8' });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

beforeAll(async () => {
  [postgres, mongo] = await Promise.all([startPostgres({ sandbox: true }), startMongo({ sandbox: true })]);
  execFileSync('npm', ['run', 'build'], { cwd: ENGINE_DIR, stdio: 'ignore' });

  const legacyConfig: ConnectionConfig = { ...postgres.config, database: 'legacy' };
  const crmConfig: ConnectionConfig = { ...mongo.config, database: 'crm' };
  const targetConfig: ConnectionConfig = { ...mongo.config, database: 'scripted' };
  const job: Job = {
    id: 'orders-script-test',
    name: 'Orders by script',
    source: { connectionId: 'legacy', collection: 'public.orders', filters: [{ field: 'order_no', op: 'lte', type: 'number', value: '50' }] },
    lookups: [{ as: 'customer', connectionId: 'crm', collection: 'customers', on: [{ source: 'customer_ref', lookup: 'customerRef' }], required: true }],
    target: { connectionId: 'target', collection: 'orders', keyFields: ['orderNo'] },
    mappings: [
      { from: 'order_no', to: 'orderNo', transform: 'number' },
      { from: 'customer.email', to: 'email', transform: 'trim' },
      { from: 'updated_at', to: 'updatedAt', transform: 'none' },
    ],
    mode: 'incremental',
    watermarkField: 'updated_at',
    batchSize: 20,
    errorPolicy: 'skip',
    createdAt: '',
    updatedAt: '',
  };
  const { fileName, content } = buildJobScript(
    job,
    [viewOf('legacy', 'Legacy PG', legacyConfig), viewOf('crm', 'Old CRM', crmConfig), viewOf('target', 'Scripted target', targetConfig)],
    '2026-10-10',
  );
  secrets = { LEGACY_PG_PASSWORD: 'postgres', OLD_CRM_URI: mongo.config.uri, SCRIPTED_TARGET_URI: mongo.config.uri };

  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR);
  // What tsx does when the user runs the .ts file: strip the types, keep the code.
  const compiled = ts.transpileModule(content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  scriptPath = resolve(WORK_DIR, fileName.replace(/\.ts$/, '.cjs'));
  writeFileSync(scriptPath, compiled.outputText);

  legacy = new Pool({ host: postgres.config.host, port: postgres.config.port, database: 'legacy', user: 'postgres', password: 'postgres', max: 1 });
  mongoClient = await MongoClient.connect(mongo.config.uri);
}, 300_000);

afterAll(async () => {
  rmSync(WORK_DIR, { recursive: true, force: true });
  await Promise.allSettled([legacy?.end(), mongoClient?.close()]);
  await Promise.allSettled([postgres?.stop(), mongo?.stop()]);
});

describe('exported job script', () => {
  it('refuses to run without its secrets and names the missing variable', () => {
    const { code, output } = runScript([], { LEGACY_PG_PASSWORD: 'postgres' });
    expect(code).toBe(1);
    expect(output).toContain('Set the environment variable OLD_CRM_URI');
  });

  it('dry-runs without writing', async () => {
    const { code, output } = runScript(['--dry-run']);
    expect(code).toBe(0);
    expect(output).toContain('Would insert 50, update 0, leave 0 unchanged');
    expect(await mongoClient.db('scripted').collection('orders').countDocuments()).toBe(0);
  });

  it('runs the job with the engine, then continues incrementally from its own state file', async () => {
    const first = runScript();
    expect(first.code).toBe(0);
    expect(first.output).toContain('Finished: 50 read, 50 written, 0 skipped');
    const orders = mongoClient.db('scripted').collection('orders');
    expect(await orders.countDocuments()).toBe(50);
    expect(await orders.findOne({ orderNo: 6 })).toMatchObject({ email: 'Customer7@Example.com' });

    await legacy.query("UPDATE public.orders SET updated_at = now() WHERE order_no IN (3, 4)");
    const second = runScript();
    expect(second.code).toBe(0);
    // The two changed rows plus the boundary row of the first run (the watermark is inclusive).
    expect(second.output).toContain('Finished: 3 read, 3 written, 0 skipped');
  });
});

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MongoClient } from 'mongodb';
import { Pool } from 'pg';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectionConfig, ConnectionView, CsvConfig, SECRET_FIELD, httpConfigSchema } from '../../src/connections/connection.model';
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

function viewOf(id: string, name: string, config: Exclude<ConnectionConfig, CsvConfig>): ConnectionView {
  const { [SECRET_FIELD[config.kind]]: _secret, ...settings } = config as Record<string, unknown>;
  return { id, name, kind: config.kind, summary: name, settings, hasSecret: true, createdAt: '', updatedAt: '' };
}

/** What tsx does when the user runs the .ts file: strip the types, keep the code. Returns the runnable file's path. */
function writeScript(fileName: string, content: string): string {
  const compiled = ts.transpileModule(content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const path = resolve(WORK_DIR, fileName.replace(/\.ts$/, '.cjs'));
  writeFileSync(path, compiled.outputText);
  return path;
}

function runScript(args: string[] = [], env: Record<string, string> = secrets, path = scriptPath) {
  const result = spawnSync(process.execPath, [path, ...args], { cwd: WORK_DIR, env: { ...process.env, ...env }, encoding: 'utf8' });
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
  scriptPath = writeScript(fileName, content);

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

  it('marks its saved watermark as UTC, and resumes an older unmarked one 14 hours earlier', async () => {
    const statePath = resolve(WORK_DIR, 'orders-script-test.state.json');
    const { watermark } = JSON.parse(readFileSync(statePath, 'utf8')) as { watermark: { type: string; value: string; utc?: true } };
    expect(watermark).toMatchObject({ type: 'date', utc: true });

    // Rows 3 and 4 hold the latest change; an unmarked watermark three hours past it must still find them.
    const unmarked = new Date(Date.parse(watermark.value) + 3 * 60 * 60 * 1000).toISOString();
    writeFileSync(statePath, JSON.stringify({ watermark: { type: 'date', value: unmarked } }));
    expect(runScript().output).toContain('Finished: 2 read, 2 written, 0 skipped');
  });

  it('saves an older watermark moved back once when no row is newer, and resumes it unchanged afterwards', () => {
    const statePath = resolve(WORK_DIR, 'orders-script-test.state.json');
    const stateWatermark = () => (JSON.parse(readFileSync(statePath, 'utf8')) as { watermark: { value: string; utc?: true } }).watermark;
    const latest = Date.parse(stateWatermark().value);
    const hour = 60 * 60 * 1000;

    // Moved back 14 hours, an unmarked watermark 20 hours past the latest change still lies after every row.
    writeFileSync(statePath, JSON.stringify({ watermark: { type: 'date', value: new Date(latest + 20 * hour).toISOString() } }));
    const upgraded = runScript();
    expect(upgraded.output).toContain('watermark saved by an older version: starting 14 h earlier to be safe');
    expect(upgraded.output).toContain('Finished: 0 read, 0 written, 0 skipped');
    const movedBack = { type: 'date', value: new Date(latest + 6 * hour).toISOString(), utc: true };
    expect(stateWatermark()).toEqual(movedBack);

    const next = runScript();
    expect(next.output).not.toContain('older version');
    expect(next.output).toContain('Finished: 0 read, 0 written, 0 skipped');
    expect(stateWatermark()).toEqual(movedBack);
  });
});

describe('exported job script with a CSV source', () => {
  let csvDir: string;
  let csvScript: string;
  let pg: Pool;

  beforeAll(async () => {
    csvDir = mkdtempSync(join(tmpdir(), 'syncforge-csv-script-'));
    writeFileSync(join(csvDir, 'readings.csv'), 'id;value;taken_at\n1;3.5;2025-05-01T08:00:00Z\n2;;2025-05-02T08:00:00Z\n3;7.25;2025-05-03T08:00:00Z\n');
    pg = new Pool({ host: postgres.config.host, port: postgres.config.port, database: 'postgres', user: 'postgres', password: 'postgres', max: 1 });
    await pg.query('CREATE TABLE public.readings (id int PRIMARY KEY, value numeric, taken_at timestamptz)');

    const job: Job = {
      id: 'csv-script-test',
      name: 'Readings from CSV',
      source: { connectionId: 'files', collection: 'readings.csv' },
      target: { connectionId: 'pg', collection: 'public.readings', keyFields: ['id'] },
      mappings: ['id', 'value', 'taken_at'].map((field) => ({ from: field, to: field, transform: 'none' as const })),
      mode: 'full',
      batchSize: 2,
      errorPolicy: 'fail',
      createdAt: '',
      updatedAt: '',
    };
    const files: ConnectionView = {
      id: 'files',
      name: 'Sample files',
      kind: 'csv',
      summary: 'Sample files',
      settings: { delimiter: 'auto' },
      hasSecret: false,
      createdAt: '',
      updatedAt: '',
    };
    const { fileName, content } = buildJobScript(job, [files, viewOf('pg', 'Script PG', postgres.config)], '2026-10-14');
    expect(content).toContain('directory: env("SAMPLE_FILES_DIRECTORY")');
    csvScript = writeScript(fileName, content);
  });

  afterAll(async () => {
    await pg?.end();
    if (csvDir) rmSync(csvDir, { recursive: true, force: true });
  });

  it('refuses to run without the folder and names its variable', () => {
    const { code, output } = runScript([], { SCRIPT_PG_PASSWORD: 'postgres' }, csvScript);
    expect(code).toBe(1);
    expect(output).toContain('Set the environment variable SAMPLE_FILES_DIRECTORY');
  });

  it('reads the files from the folder named in the environment', async () => {
    const { code, output } = runScript([], { SAMPLE_FILES_DIRECTORY: csvDir, SCRIPT_PG_PASSWORD: 'postgres' }, csvScript);
    expect(output).toContain('Finished: 3 read, 3 written, 0 skipped');
    expect(code).toBe(0);
    const { rows } = await pg.query('SELECT id, value, taken_at FROM public.readings ORDER BY id');
    expect(rows).toEqual([
      { id: 1, value: '3.5', taken_at: new Date('2025-05-01T08:00:00Z') },
      { id: 2, value: null, taken_at: new Date('2025-05-02T08:00:00Z') },
      { id: 3, value: '7.25', taken_at: new Date('2025-05-03T08:00:00Z') },
    ]);
  });
});

describe('exported job script with an HTTP API source', () => {
  const token = 'script-bearer-token-7'; // secret-scan: allow
  const authorizations: Array<string | undefined> = [];
  let server: Server;
  let httpScript: string;
  let pg: Pool;

  /** Like {@link runScript}, without blocking: the stub API answers from this process. */
  function runScriptAsync(env: Record<string, string>): Promise<{ code: number | null; output: string }> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [httpScript], { cwd: WORK_DIR, env: { ...process.env, ...env } });
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      child.on('error', reject);
      child.on('close', (code) => resolvePromise({ code, output }));
    });
  }

  beforeAll(async () => {
    server = createServer((request, response) => {
      authorizations.push(request.headers.authorization);
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
        return;
      }
      const page = Number(new URL(request.url ?? '/', 'http://stub').searchParams.get('page'));
      const items = page <= 2 ? [{ id: page * 2 - 1, score: page * 1.5 }, { id: page * 2, score: page * 2.5 }] : [];
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ items }));
    });
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    pg = new Pool({ host: postgres.config.host, port: postgres.config.port, database: 'postgres', user: 'postgres', password: 'postgres', max: 1 });
    await pg.query('CREATE TABLE public.scores (id int PRIMARY KEY, score numeric)');

    const job: Job = {
      id: 'http-script-test',
      name: 'Scores from API',
      source: { connectionId: 'api', collection: 'scores' },
      target: { connectionId: 'pg', collection: 'public.scores', keyFields: ['id'] },
      mappings: ['id', 'score'].map((field) => ({ from: field, to: field, transform: 'none' as const })),
      mode: 'full',
      batchSize: 3,
      errorPolicy: 'fail',
      createdAt: '',
      updatedAt: '',
    };
    const apiConfig = httpConfigSchema.parse({
      kind: 'http',
      baseUrl: base,
      auth: { type: 'bearer' },
      secret: token,
      endpoints: [{ name: 'scores', path: '/scores', dataPath: 'items', pagination: { type: 'page' } }],
    });
    const { fileName, content } = buildJobScript(job, [viewOf('api', 'Score API', apiConfig), viewOf('pg', 'Script PG', postgres.config)], '2026-10-19');
    expect(content).not.toContain(token);
    httpScript = writeScript(fileName, content);
  });

  afterAll(async () => {
    await pg?.end();
    server?.closeAllConnections();
    await new Promise<void>((resolvePromise) => (server ? server.close(() => resolvePromise()) : resolvePromise()));
  });

  it('refuses to run without the token and names its variable, before any request', async () => {
    const { code, output } = await runScriptAsync({ SCRIPT_PG_PASSWORD: 'postgres' });
    expect(code).toBe(1);
    expect(output).toContain('Set the environment variable SCORE_API_TOKEN');
    expect(authorizations).toEqual([]);
  });

  it('reads every page with the token from the environment', async () => {
    const { code, output } = await runScriptAsync({ SCORE_API_TOKEN: token, SCRIPT_PG_PASSWORD: 'postgres' });
    expect(output).toContain('Finished: 4 read, 4 written, 0 skipped');
    expect(code).toBe(0);
    expect(output).not.toContain(token);
    expect(authorizations).toEqual(Array(3).fill(`Bearer ${token}`));
    const { rows } = await pg.query('SELECT id, score FROM public.scores ORDER BY id');
    expect(rows).toEqual([
      { id: 1, score: '1.5' },
      { id: 2, score: '2.5' },
      { id: 3, score: '3' },
      { id: 4, score: '5' },
    ]);
  });
});

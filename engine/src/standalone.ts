import 'reflect-metadata';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NotFoundError, ValidationError, errorMessage } from './common/errors';
import { ConnectionView, ConnectorConfig, SECRET_FIELD, SECRET_REQUIRED, connectorConfigSchema } from './connections/connection.model';
import { ConnectorFactory } from './connectors/connector.factory';
import { Job, JobInput, jobInputSchema } from './jobs/job.model';
import { DryRunReport, dryRunWriterFor } from './sync/dry-run-writer';
import { LogLevel, RowFailure, RunStats, SyncRunner } from './sync/sync-runner';
import { ConnectionOpener, SyncService } from './sync/sync.service';
import { StoredWatermark } from './sync/watermark';
import { TransformRegistry } from './transforms/transform.registry';

/**
 * Runs a Syncforge job outside the app, from an exported `<job>.sync.ts` script. It uses the engine's own
 * pipeline (connectors, lookups, transforms, run loop, dry run), so a script run behaves like a run in the app.
 * Secrets come from environment variables; the script holds only the non-secret connection settings.
 */

export interface StandaloneConnection {
  name: string;
  /**
   * Connection settings as in the app, with the secret read from the environment (see `env`).
   * CSV connections also name the folder holding their files.
   */
  config: ConnectorConfig;
}

export interface StandaloneDefinition {
  job: JobInput & { id: string };
  /** Every connection the job uses, by the id the job refers to. */
  connections: Record<string, StandaloneConnection>;
  /** Where an incremental job keeps its watermark between script runs (relative to the working directory). */
  stateFile?: string;
}

export interface StandaloneResult {
  stats: RunStats;
  watermark: StoredWatermark | null;
  failures: RowFailure[];
  /** Dry runs only. */
  plan?: DryRunReport;
}

export interface StandaloneOptions {
  dryRun?: boolean;
  signal?: AbortSignal;
  log?: (level: LogLevel, message: string) => void;
}

/** The value of a required environment variable; fails with a message that names it. */
export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new ValidationError(`Set the environment variable ${name}`);
  return value;
}

/** The value of an environment variable that may be absent (e.g. a Postgres password with trust auth). */
export function optionalEnv(name: string): string {
  return process.env[name] ?? '';
}

export async function runJob(definition: StandaloneDefinition, options: StandaloneOptions = {}): Promise<StandaloneResult> {
  const job: Job = { ...jobInputSchema.parse(definition.job), id: definition.job.id, createdAt: '', updatedAt: '' };
  const sync = new SyncService(scriptConnections(definition.connections), new TransformRegistry());
  const state = new StateFile(resolve(definition.stateFile ?? `${job.id}.state.json`));
  const incremental = job.mode === 'incremental';
  const from = incremental ? await state.read() : null;
  const failures: RowFailure[] = [];
  let plan: DryRunReport | undefined;

  const result = await sync.withPipeline(job, (pipeline) => {
    const dryRunWriter = options.dryRun ? dryRunWriterFor(pipeline) : undefined;
    plan = dryRunWriter?.report;
    return new SyncRunner().run({
      job,
      source: pipeline.source,
      target: dryRunWriter ?? pipeline.target,
      mapper: pipeline.mapper,
      enricher: pipeline.enricher,
      from,
      signal: options.signal ?? new AbortController().signal,
      hooks: {
        log: options.log ?? (() => undefined),
        onBatchWritten: async (_stats, checkpoint) => {
          // Saved after every batch, so a failed run resumes where it stopped. Dry runs never move it.
          if (incremental && checkpoint && !options.dryRun) await state.write(checkpoint);
        },
        onRowFailed: (failure) => failures.push(failure),
      },
    });
  });
  return { ...result, failures, plan };
}

/**
 * Entry point for exported scripts: `--dry-run` writes nothing, Ctrl+C cancels after the current batch.
 * Exit code 0 when every row synced, 2 when some rows were listed as not synced, 1 when the run failed.
 */
export async function runFromCommandLine(definition: StandaloneDefinition): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(`Runs the Syncforge job "${definition.job.name}".\n\n  --dry-run   read, map and compare with the target, write nothing\n  --help      show this text`);
    return;
  }
  const dryRun = args.includes('--dry-run');
  const controller = new AbortController();
  process.once('SIGINT', () => {
    console.log('Cancelling after the current batch…');
    controller.abort();
  });

  const log = (level: LogLevel, message: string) => console.log(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`);
  log('info', `${dryRun ? 'Dry run' : 'Run'} of "${definition.job.name}" (${definition.job.mode ?? 'full'})`);
  try {
    const { stats, failures, plan } = await runJob(definition, { dryRun, signal: controller.signal, log });
    if (plan) log('info', `Would insert ${plan.inserts}, update ${plan.updates}, leave ${plan.unchanged} unchanged`);
    log('info', `Finished: ${stats.read} read, ${dryRun ? 0 : stats.written} written, ${stats.skipped} skipped`);
    for (const failure of failures) {
      log('warn', `Not synced: row ${failure.row}${failure.key ? ` (key ${failure.key})` : ''} [${failure.stage}]: ${failure.reason}`);
    }
    process.exitCode = failures.length > 0 ? 2 : 0;
  } catch (error) {
    log('error', errorMessage(error));
    process.exitCode = 1;
  }
}

/** Opens connections from the script's settings instead of the app's encrypted store. */
function scriptConnections(connections: Record<string, StandaloneConnection>): ConnectionOpener {
  const factory = new ConnectorFactory();
  return {
    async open(id: string) {
      const connection = connections[id];
      if (!connection) throw new NotFoundError(`The script has no connection "${id}"`);
      const config = connectorConfigSchema.parse(connection.config);
      const secretField = SECRET_FIELD[config.kind];
      if (secretField !== null && SECRET_REQUIRED[config.kind] && !(config as Record<string, unknown>)[secretField]) {
        throw new ValidationError(`Connection "${connection.name}" needs its ${secretField}`);
      }
      const view: ConnectionView = {
        id,
        name: connection.name,
        kind: config.kind,
        summary: connection.name,
        settings: {},
        hasSecret: true,
        createdAt: '',
        updatedAt: '',
      };
      return { connector: factory.create(config), view };
    },
  };
}

/** The watermark of a script-run job, in a small JSON file written atomically. */
class StateFile {
  constructor(private readonly path: string) {}

  async read(): Promise<StoredWatermark | null> {
    try {
      return (JSON.parse(await readFile(this.path, 'utf8')) as { watermark: StoredWatermark | null }).watermark;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; // first run
      throw error;
    }
  }

  async write(watermark: StoredWatermark): Promise<void> {
    const temp = `${this.path}.tmp`;
    await writeFile(temp, `${JSON.stringify({ watermark, updatedAt: new Date().toISOString() }, null, 2)}\n`);
    await rename(temp, this.path);
  }
}

import { ConnectionKind, ConnectionView, HttpAuth, SECRET_FIELD, SECRET_REQUIRED, httpAuthSchema } from '../connections/connection.model';
import { Job } from './job.model';

const SECRET_LABEL = { password: 'password', uri: 'connection string', key: 'key' } as const; // labels only; secret-scan: allow
/** HTTP APIs keep every kind of credential in `secret`; the variable is named and described after what it holds. */
const HTTP_SECRET_ENV: Record<Exclude<HttpAuth['type'], 'none'>, { envSuffix: string; label: string }> = {
  bearer: { envSuffix: 'token', label: 'bearer token' },
  basic: { envSuffix: 'password', label: 'password' },
  apiKeyHeader: { envSuffix: 'key', label: 'API key' },
  apiKeyQuery: { envSuffix: 'key', label: 'API key' },
};

/** Must equal the engine package's "name": scripts find the runner through the package's own "exports". */
export const STANDALONE_MODULE = 'sync-forge-engine/standalone';

/** "Legacy PG" + "password" → "LEGACY_PG_PASSWORD". */
export function secretEnvName(connectionName: string, field: string): string {
  const base = connectionName.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'CONNECTION';
  return `${/^[0-9]/.test(base) ? `_${base}` : base}_${field.toUpperCase()}`;
}

/** The connection setting a script reads from an environment variable, what to call it, and whether it must be set. */
export interface ScriptEnvField {
  field: string;
  label: string;
  required: boolean;
  /** Ends the variable's name when it differs from the field, e.g. TOKEN for an HTTP API's `secret`. */
  envSuffix?: string;
}

/**
 * Databases: the secret field. CSV connections have no secret, but their folder differs per machine,
 * so it comes from the environment too. HTTP APIs: the secret their auth type needs, or null without auth.
 * `settings` are the connection's settings as the API returns them (without the secret).
 */
export function scriptEnvField(kind: ConnectionKind, settings: Readonly<Record<string, unknown>>): ScriptEnvField | null {
  if (kind === 'http') {
    const auth = httpAuthSchema.parse(settings.auth ?? { type: 'none' });
    return auth.type === 'none' ? null : { field: 'secret', required: true, ...HTTP_SECRET_ENV[auth.type] };
  }
  const field = SECRET_FIELD[kind];
  if (field === null) return { field: 'directory', label: 'folder holding the CSV files', required: true };
  return { field, label: SECRET_LABEL[field], required: SECRET_REQUIRED[kind] };
}

/** A value as TypeScript source, indented to sit at `indent` spaces. */
function literal(value: unknown, indent: number): string {
  return JSON.stringify(value, null, 2).replace(/\n/g, `\n${' '.repeat(indent)}`);
}

/** Names are free text; a "*\/" inside one would end the header comment early. */
function inComment(text: string): string {
  return text.replace(/\*\//g, '*\\/');
}

/**
 * A runnable `<job>.sync.ts` for a saved job: the spec, every connection it uses without secrets, and a call
 * into the engine's standalone runner. Each secret, and each CSV folder, is read from an environment variable named in the header.
 */
export function buildJobScript(job: Job, connections: readonly ConnectionView[], exportedOn: string): { fileName: string; content: string } {
  const { createdAt: _created, updatedAt: _updated, ...spec } = job;
  const used = new Set<string>();
  const withEnv = connections.map((connection) => {
    const envField = scriptEnvField(connection.kind, connection.settings);
    if (envField === null) return { connection, env: null };
    const { field, label, required, envSuffix = field } = envField;
    let name = secretEnvName(connection.name, envSuffix);
    if (used.has(name)) name = secretEnvName(`${connection.name} ${connection.id}`, envSuffix);
    used.add(name);
    return { connection, env: { field, label, name, reader: required ? 'env' : 'optionalEnv' } };
  });
  const fromEnv = withEnv.flatMap(({ connection, env }) => (env ? [{ connection, ...env }] : []));
  const hasCsv = connections.some((connection) => connection.kind === 'csv');

  const connectionEntries = withEnv.map(({ connection, env }) => {
    const settings = Object.entries({ ...connection.settings, kind: connection.kind })
      .sort(([a], [b]) => (a === 'kind' ? -1 : b === 'kind' ? 1 : 0))
      .map(([key, value]) => `        ${JSON.stringify(key)}: ${literal(value, 8)},`);
    return [
      `    ${JSON.stringify(connection.id)}: {`,
      `      name: ${JSON.stringify(connection.name)},`,
      '      config: {',
      ...settings,
      // An HTTP API without auth has no secret: its settings are all the script needs.
      ...(env ? [`        ${env.field}: ${env.reader}(${JSON.stringify(env.name)}),`] : []),
      '      },',
      '    },',
    ].join('\n');
  });

  const envLines = fromEnv.map(
    ({ connection, label, name, reader }) =>
      ` *   ${name.padEnd(32)} ${label} of "${inComment(connection.name)}"${reader === 'optionalEnv' ? ' (optional)' : ''}`,
  );
  if (hasCsv) envLines.push(' * CSV files must keep the names they were uploaded with: the job refers to them by name.');
  const readers = [...new Set(fromEnv.map((entry) => entry.reader))].sort();

  const content = `/**
 * Syncforge job "${inComment(job.name)}" (${job.id}), exported ${exportedOn}.
 *
 * Runs with the Syncforge engine's own code, exactly like a run in the app. ${hasCsv ? 'Secrets and CSV folders come' : 'Secrets come'} from environment variables:
${envLines.join('\n')}
 *
 * Run it (after \`npm run build\` in the Syncforge engine/ folder):
 *   cd <syncforge>/engine && npx tsx <path>/${job.id}.sync.ts [--dry-run]
 * Elsewhere, install the engine first: npm install <syncforge>/engine
 *
 * Exit code 0: every row synced. 2: some rows were not synced (listed in the output). 1: the run failed.
 * Incremental jobs keep their watermark in ${job.id}.state.json in the working directory, separate from the app.
 * Hosts saved for the Docker app (host.docker.internal) may need to be localhost when run on your machine.
 */
import { ${[...readers, 'runFromCommandLine', 'type StandaloneDefinition'].join(', ')} } from '${STANDALONE_MODULE}';

const definition: StandaloneDefinition = {
  job: ${literal(spec, 2)},
  connections: {
${connectionEntries.join('\n')}
  },
  stateFile: ${JSON.stringify(`${job.id}.state.json`)},
};

void runFromCommandLine(definition);
`;
  return { fileName: `${job.id}.sync.ts`, content };
}

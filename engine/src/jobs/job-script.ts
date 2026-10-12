import { ConnectionView, SECRET_FIELD, SECRET_REQUIRED } from '../connections/connection.model';
import { Job } from './job.model';

const SECRET_LABEL = { password: 'password', uri: 'connection string', key: 'key' } as const;

/** Must equal the engine package's "name": scripts find the runner through the package's own "exports". */
export const STANDALONE_MODULE = 'sync-forge-engine/standalone';

/** "Legacy PG" + "password" → "LEGACY_PG_PASSWORD". */
export function secretEnvName(connectionName: string, field: string): string {
  const base = connectionName.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'CONNECTION';
  return `${/^[0-9]/.test(base) ? `_${base}` : base}_${field.toUpperCase()}`;
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
 * into the engine's standalone runner. Each secret is read from an environment variable named in the header.
 */
export function buildJobScript(job: Job, connections: readonly ConnectionView[], exportedOn: string): { fileName: string; content: string } {
  const { createdAt: _created, updatedAt: _updated, ...spec } = job;
  const used = new Set<string>();
  const secrets = connections.map((connection) => {
    const field = SECRET_FIELD[connection.kind];
    let name = secretEnvName(connection.name, field);
    if (used.has(name)) name = secretEnvName(`${connection.name} ${connection.id}`, field);
    used.add(name);
    return { connection, field, name, reader: SECRET_REQUIRED[connection.kind] ? 'env' : 'optionalEnv' };
  });

  const connectionEntries = secrets.map(({ connection, field, name, reader }) => {
    const settings = Object.entries({ ...connection.settings, kind: connection.kind })
      .sort(([a], [b]) => (a === 'kind' ? -1 : b === 'kind' ? 1 : 0))
      .map(([key, value]) => `        ${JSON.stringify(key)}: ${literal(value, 8)},`);
    return [
      `    ${JSON.stringify(connection.id)}: {`,
      `      name: ${JSON.stringify(connection.name)},`,
      '      config: {',
      ...settings,
      `        ${field}: ${reader}(${JSON.stringify(name)}),`,
      '      },',
      '    },',
    ].join('\n');
  });

  const envLines = secrets.map(
    ({ connection, field, name, reader }) =>
      ` *   ${name.padEnd(32)} ${SECRET_LABEL[field]} of "${inComment(connection.name)}"${reader === 'optionalEnv' ? ' (optional)' : ''}`,
  );
  const readers = [...new Set(secrets.map((secret) => secret.reader))].sort();

  const content = `/**
 * Syncforge job "${inComment(job.name)}" (${job.id}), exported ${exportedOn}.
 *
 * Runs with the Syncforge engine's own code, exactly like a run in the app. Secrets come from environment variables:
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

import { resolve } from 'node:path';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { CosmosConfig, MongoConfig, PostgresConfig } from '../../src/connections/connection.model';

/** Throwaway databases for integration tests. Each helper returns the connector config and a stop function. */

const SANDBOX_DIR = resolve(__dirname, '../../../sandbox');

export interface Started<TConfig> {
  config: TConfig;
  stop(): Promise<void>;
}

function stopper(container: StartedTestContainer): () => Promise<void> {
  return async () => {
    await container.stop();
  };
}

/** PostgreSQL 16. With `sandbox: true`, the `legacy` and `newcore` demo databases are created from sandbox/postgres. */
export async function startPostgres(options: { sandbox?: boolean } = {}): Promise<Started<PostgresConfig>> {
  let image = new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_PASSWORD: 'postgres' })
    .withExposedPorts(5432)
    // The entrypoint starts a temporary server for init scripts, then the real one.
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2));
  if (options.sandbox) {
    image = image.withCopyFilesToContainer([
      { source: resolve(SANDBOX_DIR, 'postgres/init.sql'), target: '/docker-entrypoint-initdb.d/init.sql' },
    ]);
  }
  const container = await image.start();
  return {
    config: {
      kind: 'postgres',
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: 'postgres',
      user: 'postgres',
      password: 'postgres',
      ssl: 'disable',
    },
    stop: stopper(container),
  };
}

/** The emulator's fixed, publicly documented key. Not a secret. */
const COSMOS_EMULATOR_KEY = 'C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==';

/**
 * The Linux "vnext" Cosmos DB emulator: the only one that runs on ARM (Apple Silicon) as well as x64.
 * It speaks plain HTTP by default, so no self-signed certificate is involved.
 */
export async function startCosmos(): Promise<Started<CosmosConfig>> {
  const container = await new GenericContainer('mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator:vnext-preview')
    .withExposedPorts(8081, 8080)
    .withWaitStrategy(Wait.forHttp('/ready', 8080).forStatusCode(200))
    .start();
  return {
    config: {
      kind: 'cosmos',
      endpoint: `http://${container.getHost()}:${container.getMappedPort(8081)}`,
      key: COSMOS_EMULATOR_KEY,
      database: 'test',
      allowSelfSignedCert: false,
    },
    stop: stopper(container),
  };
}

/** MongoDB 7. With `sandbox: true`, `crm.customers` is seeded from sandbox/mongo. */
export async function startMongo(options: { sandbox?: boolean } = {}): Promise<Started<MongoConfig>> {
  let image = new GenericContainer('mongo:7').withExposedPorts(27017);
  if (options.sandbox) {
    image = image
      .withCopyFilesToContainer([
        { source: resolve(SANDBOX_DIR, 'mongo/init.js'), target: '/docker-entrypoint-initdb.d/init.js' },
      ])
      // Like Postgres, init scripts run against a temporary server before the real one starts.
      .withWaitStrategy(Wait.forLogMessage(/Waiting for connections/, 2));
  } else {
    image = image.withWaitStrategy(Wait.forLogMessage(/Waiting for connections/));
  }
  const container = await image.start();
  return {
    config: {
      kind: 'mongo',
      uri: `mongodb://${container.getHost()}:${container.getMappedPort(27017)}/?directConnection=true`,
      database: 'test',
    },
    stop: stopper(container),
  };
}

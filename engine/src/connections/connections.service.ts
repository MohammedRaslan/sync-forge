import { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { ConnectorFactory } from '../connectors/connector.factory';
import { CollectionInfo, Connector, FieldInfo } from '../connectors/connector.types';
import { AppError, NotFoundError, UpstreamError, ValidationError, errorMessage } from '../common/errors';
import { createId } from '../common/ids';
import { SecretBox } from '../storage/secret-box';
import { ConnectionsRepository } from './connections.repository';
import { CsvFileStore } from './csv-file-store';
import {
  ConnectionConfig,
  ConnectorConfig,
  ConnectionInput,
  ConnectionTestResult,
  ConnectionView,
  CsvConfig,
  CsvFileInfo,
  CsvFileList,
  SECRET_FIELD,
  SECRET_REQUIRED,
  StoredConnection,
  connectionConfigSchema,
} from './connection.model';

export interface ResolvedConnection {
  view: ConnectionView;
  config: ConnectionConfig;
}

@Injectable()
export class ConnectionsService {
  constructor(
    private readonly repository: ConnectionsRepository,
    private readonly secrets: SecretBox,
    private readonly connectors: ConnectorFactory,
    private readonly files: CsvFileStore,
  ) {}

  async list(): Promise<ConnectionView[]> {
    const stored = await this.repository.list();
    return stored.map((connection) => this.toView(connection, this.decrypt(connection))).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<ConnectionView> {
    return (await this.resolve(id)).view;
  }

  async resolve(id: string): Promise<ResolvedConnection> {
    const stored = await this.repository.get(id);
    if (!stored) throw new NotFoundError(`Connection "${id}" does not exist`);
    const config = this.decrypt(stored);
    return { view: this.toView(stored, config), config };
  }

  async create(input: ConnectionInput): Promise<ConnectionView> {
    this.assertSecretPresent(input.config);
    const now = new Date().toISOString();
    const stored: StoredConnection = {
      id: createId(input.name),
      name: input.name,
      kind: input.config.kind,
      encryptedConfig: this.encrypt(input.config),
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.save(stored);
    return this.toView(stored, input.config);
  }

  async update(id: string, input: ConnectionInput): Promise<ConnectionView> {
    const stored = await this.repository.get(id);
    if (!stored) throw new NotFoundError(`Connection "${id}" does not exist`);
    const config = this.mergeSecret(input.config, this.decrypt(stored));
    this.assertSecretPresent(config);
    const updated: StoredConnection = {
      ...stored,
      name: input.name,
      kind: config.kind,
      encryptedConfig: this.encrypt(config),
      updatedAt: new Date().toISOString(),
    };
    await this.repository.save(updated);
    return this.toView(updated, config);
  }

  async remove(id: string): Promise<void> {
    if (!(await this.repository.delete(id))) throw new NotFoundError(`Connection "${id}" does not exist`);
    // Uploaded files are customer data: they go with their connection. Whatever its kind now: it may have
    // been a CSV connection with files before an edit changed its kind. Nothing to do when there are none.
    await this.files.removeAll(id);
  }

  /** The files uploaded to a CSV connection, with the current size limit for new uploads. */
  async listFiles(id: string): Promise<CsvFileList> {
    await this.csvConfig(id);
    const [maxBytes, files] = await Promise.all([this.files.maxBytes(), this.files.list(id)]);
    return { maxBytes, files };
  }

  /** Saves an upload to a CSV connection, replacing a file of the same name. */
  async saveFile(id: string, name: string, body: Readable, declaredLength?: number): Promise<CsvFileInfo> {
    const config = await this.csvConfig(id);
    return this.files.save(id, name, body, { delimiter: config.delimiter, declaredLength });
  }

  async removeFile(id: string, name: string): Promise<void> {
    await this.csvConfig(id);
    await this.files.remove(id, name);
  }

  /** Tests unsaved settings. When `existingId` is given, a blank secret falls back to the saved one. */
  async test(config: ConnectionConfig, existingId?: string): Promise<ConnectionTestResult> {
    const effective = existingId ? this.mergeSecret(config, (await this.resolve(existingId)).config) : config;
    this.assertSecretPresent(effective);
    // Uploaded files live inside Syncforge's own workspace, so there is nothing outside it to reach.
    if (effective.kind === 'csv') return { ok: true, latencyMs: 0 };
    let connector: Connector | undefined;
    const started = Date.now();
    try {
      // Inside the try: some drivers reject malformed settings in their constructor.
      connector = this.connectors.create(effective);
      await connector.ping();
      return { ok: true, latencyMs: Date.now() - started };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    } finally {
      await connector?.close().catch(() => undefined);
    }
  }

  async listCollections(id: string): Promise<CollectionInfo[]> {
    return this.use(id, (connector) => connector.listCollections());
  }

  async describeCollection(id: string, collection: string): Promise<FieldInfo[]> {
    return this.use(id, (connector) => connector.describeCollection(collection));
  }

  /** Columns of a query source, read without fetching rows. */
  async describeQuery(id: string, query: string): Promise<FieldInfo[]> {
    return this.use(id, (connector) => {
      if (!connector.describeQuery) throw new ValidationError('Custom SQL queries are only supported for PostgreSQL and MySQL');
      return connector.describeQuery(query);
    });
  }

  /** Opens a connector for a saved connection. The caller owns it and must close it. */
  async open(id: string): Promise<{ connector: Connector; view: ConnectionView }> {
    const { view, config } = await this.resolve(id);
    return { connector: this.connectors.create(this.connectorConfigFor(id, config)), view };
  }

  /** The saved settings plus what a connector needs but is not stored with them: the folder of a CSV connection. */
  private connectorConfigFor(id: string, config: ConnectionConfig): ConnectorConfig {
    return config.kind === 'csv' ? { ...config, directory: this.files.directoryFor(id) } : config;
  }

  /** The settings of a CSV connection; other kinds hold no files. */
  private async csvConfig(id: string): Promise<CsvConfig> {
    const { config } = await this.resolve(id);
    if (config.kind !== 'csv') throw new ValidationError('Only CSV connections hold files');
    return config;
  }

  /** Runs `work` with a short-lived connector and reports driver failures with the connection's name. */
  private async use<T>(id: string, work: (connector: Connector) => Promise<T>): Promise<T> {
    const { connector, view } = await this.open(id);
    try {
      return await work(connector);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new UpstreamError(`${view.name}: ${errorMessage(error)}`, error);
    } finally {
      await connector.close().catch(() => undefined);
    }
  }

  private mergeSecret(incoming: ConnectionConfig, existing: ConnectionConfig): ConnectionConfig {
    const field = SECRET_FIELD[incoming.kind];
    if (field === null) return incoming;
    const value = (incoming as Record<string, unknown>)[field];
    if (value !== '' || existing.kind !== incoming.kind) return incoming;
    return { ...incoming, [field]: (existing as Record<string, unknown>)[field] } as ConnectionConfig;
  }

  private assertSecretPresent(config: ConnectionConfig): void {
    const field = SECRET_FIELD[config.kind];
    if (field !== null && SECRET_REQUIRED[config.kind] && !(config as Record<string, unknown>)[field]) {
      throw new ValidationError(`config.${field}: Required`);
    }
  }

  private encrypt(config: ConnectionConfig): string {
    return this.secrets.encrypt(JSON.stringify(config));
  }

  private decrypt(stored: StoredConnection): ConnectionConfig {
    return connectionConfigSchema.parse(JSON.parse(this.secrets.decrypt(stored.encryptedConfig)));
  }

  private toView(stored: StoredConnection, config: ConnectionConfig): ConnectionView {
    const { secret, settings } = splitSecret(config);
    return {
      id: stored.id,
      name: stored.name,
      kind: config.kind,
      summary: summarize(config),
      settings,
      hasSecret: Boolean(secret),
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    };
  }
}

function summarize(config: ConnectionConfig): string {
  switch (config.kind) {
    case 'postgres':
    case 'mysql':
      return `${config.user}@${config.host}:${config.port}/${config.database}`;
    case 'mongo':
      return `${redactMongoUri(config.uri)} / ${config.database}`;
    case 'cosmos':
      return `${config.endpoint} / ${config.database}`;
    case 'csv':
      return `CSV files, delimiter ${config.delimiter === '\t' ? 'tab' : config.delimiter}`;
  }
}

/** The settings without the secret field, and the secret apart. Kinds without a secret keep every setting. */
function splitSecret(config: ConnectionConfig): { secret: unknown; settings: Record<string, unknown> } {
  const field = SECRET_FIELD[config.kind];
  if (field === null) return { secret: undefined, settings: { ...config } };
  const { [field]: secret, ...settings } = config as Record<string, unknown>;
  return { secret, settings };
}

/** mongodb://user:pass@host:27017/?x=y becomes mongodb://host:27017 */
export function redactMongoUri(uri: string): string {
  return uri.replace(/^(mongodb(?:\+srv)?:\/\/)(?:[^@/]*@)?([^/?]*).*$/, '$1$2');
}

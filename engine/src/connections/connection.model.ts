import { z } from 'zod';

const requiredText = z.string().trim().min(1, 'Required');

export const postgresConfigSchema = z.object({
  kind: z.literal('postgres'),
  host: requiredText,
  port: z.coerce.number().int().min(1).max(65535).default(5432),
  database: requiredText,
  user: requiredText,
  password: z.string().default(''),
  ssl: z.enum(['disable', 'require', 'verify-full']).default('disable'),
});

export const mysqlConfigSchema = z.object({
  kind: z.literal('mysql'),
  host: requiredText,
  port: z.coerce.number().int().min(1).max(65535).default(3306),
  database: requiredText,
  user: requiredText,
  password: z.string().default(''),
  ssl: z.enum(['disable', 'require', 'verify-full']).default('disable'),
});

export const mongoConfigSchema = z.object({
  kind: z.literal('mongo'),
  uri: z
    .string()
    .trim()
    .default('')
    .refine((uri) => uri === '' || /^mongodb(\+srv)?:\/\//.test(uri), 'Must start with mongodb:// or mongodb+srv://'),
  database: requiredText,
});

export const cosmosConfigSchema = z.object({
  kind: z.literal('cosmos'),
  endpoint: z.string().trim().url('Must be a URL such as https://localhost:8081'),
  key: z.string().trim().default(''),
  database: requiredText,
  allowSelfSignedCert: z.boolean().default(false),
});

/** CSV files uploaded to Syncforge. The folder is not a setting: whoever opens the connector supplies it. */
export const csvConfigSchema = z.object({
  kind: z.literal('csv'),
  delimiter: z.enum(['auto', ',', ';', '\t']).default('auto'),
});

export const connectionConfigSchema = z.discriminatedUnion('kind', [
  postgresConfigSchema,
  mysqlConfigSchema,
  mongoConfigSchema,
  cosmosConfigSchema,
  csvConfigSchema,
]);

/** What a connector is opened with: the saved settings, plus the folder for CSV connections. */
export const connectorConfigSchema = z.discriminatedUnion('kind', [
  postgresConfigSchema,
  mysqlConfigSchema,
  mongoConfigSchema,
  cosmosConfigSchema,
  csvConfigSchema.extend({ directory: requiredText }),
]);

export const connectionInputSchema = z.object({
  name: z.string().trim().min(1, 'Required').max(80),
  config: connectionConfigSchema,
});

export type PostgresConfig = z.infer<typeof postgresConfigSchema>;
export type MysqlConfig = z.infer<typeof mysqlConfigSchema>;
export type MongoConfig = z.infer<typeof mongoConfigSchema>;
export type CosmosConfig = z.infer<typeof cosmosConfigSchema>;
export type CsvConfig = z.infer<typeof csvConfigSchema>;
export type ConnectionConfig = z.infer<typeof connectionConfigSchema>;
export type ConnectorConfig = z.infer<typeof connectorConfigSchema>;
export type ConnectionKind = ConnectionConfig['kind'];
export type ConnectionInput = z.infer<typeof connectionInputSchema>;

/**
 * The one field per kind that holds credentials, or null for a kind without any (CSV files).
 * It is never returned by the API; when editing, leaving it blank keeps the saved value.
 */
export const SECRET_FIELD = {
  postgres: 'password',
  mysql: 'password',
  mongo: 'uri',
  cosmos: 'key',
  csv: null,
} as const satisfies Record<ConnectionKind, string | null>;

/** Postgres and MySQL may legitimately use passwordless auth; the others cannot work without their secret. */
export const SECRET_REQUIRED: Record<ConnectionKind, boolean> = {
  postgres: false,
  mysql: false,
  mongo: true,
  cosmos: true,
  csv: false,
};

/** On disk: only the name and kind are readable; hosts, usernames and secrets are encrypted. */
export interface StoredConnection {
  id: string;
  name: string;
  kind: ConnectionKind;
  encryptedConfig: string;
  createdAt: string;
  updatedAt: string;
}

/** What the API returns: settings without the secret. */
export interface ConnectionView {
  id: string;
  name: string;
  kind: ConnectionKind;
  summary: string;
  settings: Record<string, unknown>;
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A file uploaded to a CSV connection. */
export interface CsvFileInfo {
  name: string;
  size: number;
  /** ISO timestamp of the last upload. */
  modifiedAt: string;
}

/** What `GET /connections/:id/files` returns: the files and the largest upload accepted now, in bytes. */
export interface CsvFileList {
  maxBytes: number;
  files: CsvFileInfo[];
}

export type ConnectionTestResult = { ok: true; latencyMs: number } | { ok: false; message: string };

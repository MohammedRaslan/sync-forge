import { resolve } from 'node:path';

export interface AppConfig {
  readonly host: string;
  readonly port: number;
  readonly workspaceDir: string;
  /** Folder with the built UI. When set, the engine serves it next to the API. */
  readonly uiDir: string | undefined;
  /** Base64 encoded 32-byte key. When absent, a key is generated inside the workspace. */
  readonly secretKey: string | undefined;
  readonly corsOrigin: string;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a valid port number, got "${env.PORT}"`);
  }
  return {
    // Loopback by default: this tool holds database credentials and must not be reachable from the network.
    host: env.HOST ?? '127.0.0.1',
    port,
    workspaceDir: resolve(env.WORKSPACE_DIR ?? './workspace'),
    uiDir: env.UI_DIR ? resolve(env.UI_DIR) : undefined,
    secretKey: env.SYNCFORGE_SECRET_KEY || undefined,
    corsOrigin: env.CORS_ORIGIN ?? 'http://localhost:5173',
  };
}

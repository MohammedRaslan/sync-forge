import type {
  CollectionInfo,
  Connection,
  ConnectionConfig,
  ConnectionInput,
  ConnectionTestResult,
  CsvFileInfo,
  CsvFileList,
  FieldInfo,
  HttpConfig,
  HttpEndpoint,
  HttpProbeResult,
  Job,
  JobInput,
  PreviewResult,
  ReconcileReport,
  ReconcileSummary,
  SourcePreview,
  RunRecord,
  RunSummary,
  Settings,
  SettingsView,
  TransformInfo,
  Watermark,
} from './types';

export interface ApiIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: ApiIssue[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const ENGINE_UNREACHABLE = 'The Syncforge engine is not reachable. Is it running?';

/** The engine's body for a refused request. */
interface ErrorPayload {
  message?: string;
  issues?: ApiIssue[];
}

/** The error for a non-2xx response, from the engine's body when there is one. */
function errorFor(status: number, payload: ErrorPayload): ApiError {
  return new ApiError(payload.message ?? `Request failed with status ${status}`, status, payload.issues);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(ENGINE_UNREACHABLE, 0);
  }
  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw errorFor(response.status, payload);
  return payload as T;
}

/**
 * Sends a file as the raw request body. XMLHttpRequest rather than fetch, because only XHR reports upload progress.
 * The type is always text/csv: Windows labels CSV files application/vnd.ms-excel, which the engine refuses.
 */
function uploadCsv(path: string, file: File, onProgress?: (fraction: number) => void): Promise<CsvFileInfo> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api${path}`);
    xhr.setRequestHeader('Content-Type', 'text/csv');
    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      };
    }
    xhr.onerror = () => reject(new ApiError(ENGINE_UNREACHABLE, 0));
    xhr.onload = () => {
      let payload: unknown = {};
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        // A body that is not JSON leaves the generic message below.
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(payload as CsvFileInfo);
      else reject(errorFor(xhr.status, payload as ErrorPayload));
    };
    xhr.send(file);
  });
}

const enc = encodeURIComponent;

export const api = {
  connections: {
    list: () => request<Connection[]>('GET', '/connections'),
    create: (input: ConnectionInput) => request<Connection>('POST', '/connections', input),
    update: (id: string, input: ConnectionInput) => request<Connection>('PUT', `/connections/${enc(id)}`, input),
    remove: (id: string) => request<void>('DELETE', `/connections/${enc(id)}`),
    test: (config: ConnectionConfig, connectionId?: string) =>
      request<ConnectionTestResult>('POST', '/connections/test', { config, connectionId }),
    /** One trial request to an endpoint of unsaved HTTP API settings; a blank secret uses the saved one of `connectionId`. */
    probeHttp: (config: Omit<HttpConfig, 'endpoints'>, endpoint: HttpEndpoint, connectionId?: string) =>
      request<HttpProbeResult>('POST', '/connections/http/probe', { config, endpoint, connectionId }),
    collections: (id: string) => request<CollectionInfo[]>('GET', `/connections/${enc(id)}/collections`),
    fields: (id: string, collection: string) =>
      request<FieldInfo[]>('GET', `/connections/${enc(id)}/fields?collection=${enc(collection)}`),
    queryFields: (id: string, query: string) => request<FieldInfo[]>('POST', `/connections/${enc(id)}/query-fields`, { query }),
    files: (id: string) => request<CsvFileList>('GET', `/connections/${enc(id)}/files`),
    uploadFile: (id: string, file: File, name: string, onProgress?: (fraction: number) => void) =>
      uploadCsv(`/connections/${enc(id)}/files/${enc(name)}`, file, onProgress),
    removeFile: (id: string, name: string) => request<void>('DELETE', `/connections/${enc(id)}/files/${enc(name)}`),
  },
  jobs: {
    list: () => request<Job[]>('GET', '/jobs'),
    get: (id: string) => request<Job>('GET', `/jobs/${enc(id)}`),
    exportScript: (id: string) => request<{ fileName: string; content: string }>('GET', `/jobs/${enc(id)}/export`),
    create: (input: JobInput) => request<Job>('POST', '/jobs', input),
    update: (id: string, input: JobInput) => request<Job>('PUT', `/jobs/${enc(id)}`, input),
    remove: (id: string) => request<void>('DELETE', `/jobs/${enc(id)}`),
    preview: (input: JobInput) => request<PreviewResult>('POST', '/jobs/preview', input),
    sourcePreview: (input: Pick<JobInput, 'source' | 'lookups' | 'mode' | 'watermarkField' | 'mappings'>) =>
      request<SourcePreview>('POST', '/jobs/source-preview', input),
    watermark: (id: string) => request<{ watermark: Watermark | null }>('GET', `/jobs/${enc(id)}/watermark`),
    resetWatermark: (id: string) => request<void>('DELETE', `/jobs/${enc(id)}/watermark`),
    runs: (id: string) => request<RunSummary[]>('GET', `/jobs/${enc(id)}/runs`),
    /** `retryOf`: re-run the failed rows of that earlier run of the job (not combinable with `dryRun`). */
    start: (id: string, options: { dryRun?: boolean; retryOf?: string } = {}) =>
      request<RunRecord>('POST', `/jobs/${enc(id)}/runs`, options),
    reconcile: (id: string) => request<ReconcileReport>('POST', `/jobs/${enc(id)}/reconcile`),
  },
  reconciles: {
    latest: () => request<Record<string, ReconcileSummary>>('GET', '/reconciles/latest'),
  },
  runs: {
    latest: () => request<Record<string, RunSummary>>('GET', '/runs/latest'),
    get: (id: string) => request<RunRecord>('GET', `/runs/${enc(id)}`),
    cancel: (id: string) => request<RunRecord>('POST', `/runs/${enc(id)}/cancel`),
  },
  transforms: {
    list: () => request<TransformInfo[]>('GET', '/transforms'),
  },
  settings: {
    get: () => request<SettingsView>('GET', '/settings'),
    update: (settings: Settings) => request<SettingsView>('PUT', '/settings', settings),
    /** Saves the defaults. The engine fills every omitted field with its default, so the UI keeps no copy of them. */
    reset: () => request<SettingsView>('PUT', '/settings', {}),
  },
};

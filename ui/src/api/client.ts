import type {
  CollectionInfo,
  Connection,
  ConnectionConfig,
  ConnectionInput,
  ConnectionTestResult,
  FieldInfo,
  Job,
  JobInput,
  PreviewResult,
  ReconcileReport,
  ReconcileSummary,
  SourcePreview,
  RunRecord,
  RunSummary,
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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('The Syncforge engine is not reachable. Is it running?', 0);
  }
  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(payload.message ?? `Request failed with status ${response.status}`, response.status, payload.issues);
  }
  return payload as T;
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
    collections: (id: string) => request<CollectionInfo[]>('GET', `/connections/${enc(id)}/collections`),
    fields: (id: string, collection: string) =>
      request<FieldInfo[]>('GET', `/connections/${enc(id)}/fields?collection=${enc(collection)}`),
    queryFields: (id: string, query: string) => request<FieldInfo[]>('POST', `/connections/${enc(id)}/query-fields`, { query }),
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
    start: (id: string, options: { dryRun?: boolean } = {}) => request<RunRecord>('POST', `/jobs/${enc(id)}/runs`, options),
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
};

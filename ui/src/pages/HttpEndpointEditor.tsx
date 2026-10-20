import { useEffect, useId, useState } from 'react';
import { api } from '../api/client';
import type { HttpConfig, HttpEndpoint, HttpPagination, HttpProbeResult } from '../api/types';
import { ErrorNotice } from '../components/Feedback';
import { FormField } from '../components/FormField';
import { HeaderList } from '../components/HeaderList';
import { Icon } from '../components/Icon';
import { KeyValueEditor } from '../components/KeyValueEditor';
import { NumberInput } from '../components/NumberInput';
import { formatBytes, formatCount } from '../lib/format';

/** Headers and query parameters are stored and exported as plain settings; only the auth secret is encrypted. */
export const NOT_SECRET_HINT = 'Not secret: shown here and written into exported scripts. Use the auth options for keys.';

/** A new endpoint: the whole body is the list, one request. */
export const NEW_ENDPOINT: HttpEndpoint = { name: '', path: '/', query: [], dataPath: '$', pagination: { type: 'none' } };

/** Page size filled in when a page size parameter is first named; the same default as offset paging. */
const DEFAULT_PAGE_SIZE = 100;
/** Largest page size the engine accepts (connection.model.ts). */
const MAX_PAGE_SIZE = 10_000;

const PAGINATION_OPTIONS: Array<{ type: HttpPagination['type']; label: string }> = [
  { type: 'none', label: 'None' },
  { type: 'page', label: 'Page number' },
  { type: 'offset', label: 'Offset' },
  { type: 'cursor', label: 'Cursor' },
  { type: 'nextUrl', label: 'Next URL' },
  { type: 'linkHeader', label: 'Link header' },
];

/** A pagination of `type` with the engine's defaults filled in. */
function defaultPagination(type: HttpPagination['type']): HttpPagination {
  switch (type) {
    case 'none':
      return { type };
    case 'page':
      return { type, pageParam: 'page', firstPage: 1 };
    case 'offset':
      return { type, offsetParam: 'offset', limitParam: 'limit', limit: DEFAULT_PAGE_SIZE };
    case 'cursor':
      return { type, cursorPath: '', cursorParam: '' };
    case 'nextUrl':
      return { type, nextUrlPath: '' };
    case 'linkHeader':
      return { type, header: 'Link' };
  }
}

/** Same rule as the engine's endpoint names (connection.model.ts). */
const ENDPOINT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;
/** The name a probe sends when the typed one is blank or not valid yet; a probe never stores it. */
const PROBE_NAME = 'probe';

/** Whether the chosen pagination has every field it needs; blank numbers are NaN (see NumberInput). */
function paginationComplete(pagination: HttpPagination): boolean {
  switch (pagination.type) {
    case 'none':
      return true;
    case 'page':
      return Boolean(pagination.pageParam.trim()) && !Number.isNaN(pagination.firstPage) && !(pagination.size && Number.isNaN(pagination.size.value));
    case 'offset':
      return Boolean(pagination.offsetParam.trim() && pagination.limitParam.trim()) && !Number.isNaN(pagination.limit);
    case 'cursor':
      return Boolean(pagination.cursorPath.trim() && pagination.cursorParam.trim());
    case 'nextUrl':
      return Boolean(pagination.nextUrlPath.trim());
    case 'linkHeader':
      return Boolean(pagination.header.trim());
  }
}

/** Why the seconds between requests cannot be sent as they are: a blank would be sent as null. */
export function intervalProblem(config: Pick<HttpConfig, 'minIntervalSeconds'>): string | undefined {
  return Number.isNaN(config.minIntervalSeconds) ? 'Seconds between requests: enter a number (0 means no limit).' : undefined;
}

/** The first blank number in an endpoint's pagination, as a message; a blank would be sent as null. */
export function paginationNumberProblem(endpoint: HttpEndpoint): string | undefined {
  const pagination = endpoint.pagination;
  const label = endpoint.name ? `Endpoint "${endpoint.name}"` : 'An endpoint';
  if (pagination.type === 'page' && Number.isNaN(pagination.firstPage)) return `${label}: enter the first page.`;
  if (pagination.type === 'page' && pagination.size && Number.isNaN(pagination.size.value)) return `${label}: enter the page size.`;
  if (pagination.type === 'offset' && Number.isNaN(pagination.limit)) return `${label}: enter the page size.`;
  return undefined;
}

/** What one "Detect data" click found, with the request inputs it was made from. */
interface Probe {
  /** The connection settings, path, parameters and pagination as they were; a change to any of them hides the result. */
  inputs: string;
  result: HttpProbeResult;
  /** The paging fields were incomplete, so the probe asked for the first page without pagination. */
  firstPageOnly: boolean;
}

/** 429 is the API asking to slow down; other 4xx and 5xx statuses are failures. */
function statusTone(status: number): string {
  if (status >= 200 && status < 300) return 'is-ok';
  if (status === 429) return 'is-warn';
  return status >= 400 ? 'is-failed' : '';
}

/**
 * One endpoint of an HTTP API: its path and parameters, how it pages, and where the records are in a response.
 * "Detect data" sends one request with the connection settings as they are in the form.
 */
export function EndpointEditor({ endpoint, index, probeConfig, connectionId, canRemove, onChange, onRemove }: {
  endpoint: HttpEndpoint;
  index: number;
  /** The connection settings without the endpoint list, as a probe takes them. */
  probeConfig: Omit<HttpConfig, 'endpoints'>;
  /** The saved connection, whose secret a blank one stands for. */
  connectionId?: string;
  canRemove: boolean;
  onChange: (endpoint: HttpEndpoint) => void;
  onRemove: () => void;
}) {
  const paginationLabelId = useId();
  const radioName = useId();
  // Jobs and lookups store the endpoint name, so it is committed on blur rather than on every keystroke.
  const [name, setName] = useState(endpoint.name);
  useEffect(() => setName(endpoint.name), [endpoint.name]);
  const commitName = () => {
    const next = name.trim();
    if (next !== endpoint.name) onChange({ ...endpoint, name: next });
    else setName(endpoint.name);
  };
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<Probe>();
  const [probeError, setProbeError] = useState<{ inputs: string; error: unknown }>();
  // Everything a probe request is built from except the name and data path; a result is shown only while it matches.
  const inputs = JSON.stringify([probeConfig, endpoint.path, endpoint.query, endpoint.pagination]);
  const shownProbe = probe?.inputs === inputs ? probe : undefined;
  const shownError = probeError?.inputs === inputs ? probeError.error : undefined;

  const detect = async () => {
    setProbe(undefined);
    const problem = intervalProblem(probeConfig);
    if (problem) {
      setProbeError({ inputs, error: new Error(problem) });
      return;
    }
    setProbing(true);
    setProbeError(undefined);
    // Detect is for finding the data path, so unfinished name or paging fields do not stop it.
    const firstPageOnly = !paginationComplete(endpoint.pagination);
    const probed: HttpEndpoint = {
      ...endpoint,
      name: ENDPOINT_NAME.test(name.trim()) ? name.trim() : PROBE_NAME,
      pagination: firstPageOnly ? { type: 'none' } : endpoint.pagination,
    };
    try {
      setProbe({ inputs, result: await api.connections.probeHttp(probeConfig, probed, connectionId), firstPageOnly });
    } catch (error) {
      setProbeError({ inputs, error });
    } finally {
      setProbing(false);
    }
  };

  const label = endpoint.name || `endpoint ${index + 1}`;

  return (
    <div className="endpoint">
      <div className="endpoint-head">
        <FormField label="Name" hint="Jobs and lookups choose the endpoint by this name.">
          {(props) => (
            <input
              {...props}
              className="mono"
              placeholder="users"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={commitName}
              onKeyDown={(event) => event.key === 'Enter' && (event.preventDefault(), commitName())}
              spellCheck={false}
              required
            />
          )}
        </FormField>
        <FormField label="Path" hint="Added to the base URL.">
          {(props) => (
            <input
              {...props}
              className="mono"
              placeholder="/users"
              value={endpoint.path}
              onChange={(event) => onChange({ ...endpoint, path: event.target.value })}
              spellCheck={false}
              required
            />
          )}
        </FormField>
        <button type="button" className="icon-button endpoint-remove" aria-label={`Remove ${label}`} disabled={!canRemove} onClick={onRemove}>
          <Icon name="x" />
        </button>
      </div>

      <KeyValueEditor
        legend="Query params"
        itemLabel="parameter"
        namePlaceholder="status"
        valuePlaceholder="active"
        pairs={endpoint.query}
        onChange={(query) => onChange({ ...endpoint, query })}
        hint={`Only for this endpoint. ${NOT_SECRET_HINT}`}
      />

      <div className="field">
        <span className="field-label" id={paginationLabelId}>
          Pagination
        </span>
        <fieldset className="segmented segmented-grid" aria-labelledby={paginationLabelId}>
          {PAGINATION_OPTIONS.map((option) => (
            <label key={option.type} className={endpoint.pagination.type === option.type ? 'is-selected' : undefined}>
              <input
                type="radio"
                name={`${radioName}-pagination`}
                checked={endpoint.pagination.type === option.type}
                onChange={() => onChange({ ...endpoint, pagination: defaultPagination(option.type) })}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      </div>
      <PaginationFields pagination={endpoint.pagination} onChange={(pagination) => onChange({ ...endpoint, pagination })} />

      <div className="query-actions">
        <button type="button" className="btn" onClick={detect} disabled={probing || !probeConfig.baseUrl.trim()}>
          <Icon name="eye" /> {probing ? 'Detecting…' : 'Detect data'}
        </button>
      </div>
      <ErrorNotice error={shownError} />
      {shownProbe && (
        <ProbeResult
          result={shownProbe.result}
          firstPageOnly={shownProbe.firstPageOnly}
          dataPath={endpoint.dataPath}
          radioName={`${radioName}-data`}
          onPick={(dataPath) => onChange({ ...endpoint, dataPath })}
        />
      )}
      <FormField label="Data path" hint="Where the records are: $ when the body is the list itself, otherwise a dotted path such as data.items.">
        {(props) => (
          <input
            {...props}
            className="mono"
            value={endpoint.dataPath}
            onChange={(event) => onChange({ ...endpoint, dataPath: event.target.value })}
            spellCheck={false}
            required
          />
        )}
      </FormField>
    </div>
  );
}

/** The settings of the chosen pagination type; nothing for `none`. */
function PaginationFields({ pagination, onChange }: { pagination: HttpPagination; onChange: (pagination: HttpPagination) => void }) {
  switch (pagination.type) {
    case 'none':
      return null;
    case 'page':
      return (
        <div className="form-grid">
          <FormField label="Page parameter">
            {(props) => (
              <input {...props} className="mono" value={pagination.pageParam} onChange={(e) => onChange({ ...pagination, pageParam: e.target.value })} required />
            )}
          </FormField>
          <FormField label="First page">
            {(props) => <NumberInput {...props} min={0} step={1} value={pagination.firstPage} onChange={(firstPage) => onChange({ ...pagination, firstPage })} required />}
          </FormField>
          <FormField label="Page size parameter" hint="Optional, e.g. per_page.">
            {(props) => (
              <input
                {...props}
                className="mono"
                value={pagination.size?.param ?? ''}
                onChange={(e) =>
                  onChange({
                    ...pagination,
                    size: e.target.value.trim() ? { param: e.target.value, value: pagination.size?.value ?? DEFAULT_PAGE_SIZE } : undefined,
                  })
                }
              />
            )}
          </FormField>
          <FormField label="Page size">
            {(props) => (
              <NumberInput
                {...props}
                min={1}
                max={MAX_PAGE_SIZE}
                step={1}
                disabled={!pagination.size}
                value={pagination.size?.value ?? Number.NaN}
                onChange={(value) => pagination.size && onChange({ ...pagination, size: { ...pagination.size, value } })}
                required={Boolean(pagination.size)}
              />
            )}
          </FormField>
        </div>
      );
    case 'offset':
      return (
        <div className="form-grid">
          <FormField label="Offset parameter">
            {(props) => (
              <input {...props} className="mono" value={pagination.offsetParam} onChange={(e) => onChange({ ...pagination, offsetParam: e.target.value })} required />
            )}
          </FormField>
          <FormField label="Limit parameter">
            {(props) => (
              <input {...props} className="mono" value={pagination.limitParam} onChange={(e) => onChange({ ...pagination, limitParam: e.target.value })} required />
            )}
          </FormField>
          <FormField label="Page size">
            {(props) => (
              <NumberInput {...props} min={1} max={MAX_PAGE_SIZE} step={1} value={pagination.limit} onChange={(limit) => onChange({ ...pagination, limit })} required />
            )}
          </FormField>
        </div>
      );
    case 'cursor':
      return (
        <div className="form-grid">
          <FormField label="Cursor field" hint="Where a response holds the next cursor.">
            {(props) => (
              <input
                {...props}
                className="mono"
                placeholder="meta.next_cursor"
                value={pagination.cursorPath}
                onChange={(e) => onChange({ ...pagination, cursorPath: e.target.value })}
                required
              />
            )}
          </FormField>
          <FormField label="Cursor parameter" hint="Sends the cursor to get the next page.">
            {(props) => (
              <input
                {...props}
                className="mono"
                placeholder="cursor"
                value={pagination.cursorParam}
                onChange={(e) => onChange({ ...pagination, cursorParam: e.target.value })}
                required
              />
            )}
          </FormField>
        </div>
      );
    case 'nextUrl':
      return (
        <div className="form-grid">
          <FormField label="Next URL field" wide hint="Where a response holds the URL of the next page. It must be on the same host as the base URL.">
            {(props) => (
              <input
                {...props}
                className="mono"
                placeholder="links.next"
                value={pagination.nextUrlPath}
                onChange={(e) => onChange({ ...pagination, nextUrlPath: e.target.value })}
                required
              />
            )}
          </FormField>
        </div>
      );
    case 'linkHeader':
      return (
        <div className="form-grid">
          <FormField label="Header" hint='Follows its rel="next" link.'>
            {(props) => <input {...props} className="mono" value={pagination.header} onChange={(e) => onChange({ ...pagination, header: e.target.value })} required />}
          </FormField>
        </div>
      );
  }
}

/** What "Detect data" found: the response, and the lists of records in it to pick the data path from. */
function ProbeResult({ result, firstPageOnly, dataPath, radioName, onPick }: {
  result: HttpProbeResult;
  firstPageOnly: boolean;
  dataPath: string;
  radioName: string;
  onPick: (dataPath: string) => void;
}) {
  const ok = result.status >= 200 && result.status < 300;
  return (
    <div className="probe-result" role="status">
      <p className="probe-facts">
        <span className={`probe-status ${statusTone(result.status)}`}>HTTP {result.status}</span>
        <span>{result.latencyMs} ms</span>
        <span>{formatBytes(result.bytes)}</span>
        {result.contentType && <code>{result.contentType}</code>}
      </p>
      <HeaderList headers={result.rateLimit} label="Rate-limit headers" />
      {firstPageOnly && <p className="field-hint">Paging fields are empty, so only the first page was fetched.</p>}
      {ok && result.arrays.length === 0 && (
        <p className="field-hint">No list of records found in the response. Type the data path below if you know it.</p>
      )}
      {result.arrays.length > 0 && (
        <fieldset className="probe-arrays">
          <legend>Records are in</legend>
          {result.arrays.map((array) => (
            <label key={array.path} className="probe-array">
              <input type="radio" name={radioName} checked={dataPath === array.path} onChange={() => onPick(array.path)} />
              <code>{array.path}</code>
              <span>
                {formatCount(array.items)} {array.items === 1 ? 'item' : 'items'}
              </span>
              {array.keys.length > 0 && <code className="probe-keys">{array.keys.join(', ')}</code>}
            </label>
          ))}
        </fieldset>
      )}
      {result.nextPage && (
        <p className="field-hint">
          Next page: <code>{result.nextPage}</code>
        </p>
      )}
    </div>
  );
}

import { useId, useRef, useState } from 'react';
import type { Connection, HttpAuth, HttpConfig, HttpEndpoint } from '../api/types';
import { FormField } from '../components/FormField';
import { Icon } from '../components/Icon';
import { KeyValueEditor } from '../components/KeyValueEditor';
import { NumberInput } from '../components/NumberInput';
import { EndpointEditor, NEW_ENDPOINT, NOT_SECRET_HINT, intervalProblem, paginationNumberProblem } from './HttpEndpointEditor';

/** The HTTP API settings the connection form edits: the config without its kind. */
export type HttpSettings = Omit<HttpConfig, 'kind'>;

const AUTH_OPTIONS: Array<{ type: HttpAuth['type']; label: string }> = [
  { type: 'none', label: 'None' },
  { type: 'bearer', label: 'Bearer token' },
  { type: 'basic', label: 'Basic' },
  { type: 'apiKeyHeader', label: 'API key (header)' },
  { type: 'apiKeyQuery', label: 'API key (query)' },
];

const SECRET_LABEL: Record<Exclude<HttpAuth['type'], 'none'>, string> = {
  bearer: 'Token',
  basic: 'Password',
  apiKeyHeader: 'API key',
  apiKeyQuery: 'API key',
};

/** Same limit as the engine (connection.model.ts). */
const MAX_ENDPOINTS = 50;

/** An auth of `type` with the usual names filled in. */
function defaultAuth(type: HttpAuth['type']): HttpAuth {
  switch (type) {
    case 'none':
    case 'bearer':
      return { type };
    case 'basic':
      return { type, username: '' };
    case 'apiKeyHeader':
      return { type, header: 'X-API-Key' };
    case 'apiKeyQuery':
      return { type, param: 'api_key' };
  }
}

/** The saved settings of an HTTP API connection; the engine returns its config without the secret. */
function savedSettings(connection: Connection | undefined): Omit<HttpConfig, 'secret'> | undefined {
  return connection?.kind === 'http' ? (connection.settings as Omit<HttpConfig, 'secret'>) : undefined;
}

/** Scheme, host and port of a URL; undefined for text that is not an http(s) URL. */
function originOf(text: string): string | undefined {
  try {
    const url = new URL(text.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** The first blank number in the settings, as a message, so a test is not sent with nulls in it. */
export function httpNumberProblem(settings: HttpSettings): string | undefined {
  return intervalProblem(settings) ?? settings.endpoints.map(paginationNumberProblem).find((problem) => problem !== undefined);
}

/** The form's starting values: the saved settings with a blank secret, or a new API with one endpoint. */
export function initialHttpSettings(connection?: Connection): HttpSettings {
  const saved = savedSettings(connection);
  if (!saved) {
    return { baseUrl: '', auth: { type: 'none' }, secret: '', headers: [], query: [], minIntervalSeconds: 0, endpoints: [NEW_ENDPOINT] };
  }
  return {
    baseUrl: saved.baseUrl,
    auth: saved.auth,
    secret: '',
    headers: saved.headers,
    query: saved.query,
    minIntervalSeconds: saved.minIntervalSeconds,
    endpoints: saved.endpoints,
  };
}

/** Whether a blank secret keeps the saved one, or why it no longer can. */
function secretHint(keepsSecret: boolean, movedHost: boolean): string | undefined {
  if (keepsSecret) return 'Leave blank to keep the saved one.';
  return movedHost ? 'The base URL moved to another host, so enter the credential again.' : undefined;
}

/** Settings of an HTTP API connection: base URL, auth, shared headers and parameters, request spacing, endpoints. */
export function HttpConnectionFields({ value, onChange, connection }: {
  value: HttpSettings;
  onChange: (value: HttpSettings) => void;
  /** The connection being edited, if any. */
  connection?: Connection;
}) {
  const authLabelId = useId();
  const authRadioName = useId();
  // Endpoint editors keep a probe result each, so they need keys that survive removing an endpoint above them.
  const nextKey = useRef(value.endpoints.length);
  const [endpointKeys, setEndpointKeys] = useState(() => value.endpoints.map((_, index) => index));

  const set = <K extends keyof HttpSettings>(field: K, next: HttpSettings[K]) => onChange({ ...value, [field]: next });
  // The engine keeps a saved secret for a blank one only while the auth type and the base URL's host stay the same,
  // so a saved credential is never sent to another server.
  const saved = savedSettings(connection);
  const sameAuth = Boolean(connection?.hasSecret && saved?.auth.type === value.auth.type);
  const editedOrigin = originOf(value.baseUrl);
  const keepsSecret = sameAuth && editedOrigin !== undefined && editedOrigin === originOf(saved?.baseUrl ?? '');
  const movedHost = sameAuth && editedOrigin !== undefined && !keepsSecret;
  const { baseUrl, auth, secret, headers, query, minIntervalSeconds } = value;
  const probeConfig: Omit<HttpConfig, 'endpoints'> = { kind: 'http', baseUrl, auth, secret, headers, query, minIntervalSeconds };

  const setEndpoint = (index: number, endpoint: HttpEndpoint) => set('endpoints', value.endpoints.map((e, i) => (i === index ? endpoint : e)));
  const addEndpoint = () => {
    const key = nextKey.current++;
    setEndpointKeys((keys) => [...keys, key]);
    set('endpoints', [...value.endpoints, NEW_ENDPOINT]);
  };
  const removeEndpoint = (index: number) => {
    setEndpointKeys((keys) => keys.filter((_, i) => i !== index));
    set('endpoints', value.endpoints.filter((_, i) => i !== index));
  };

  const secretField =
    auth.type === 'none' ? null : (
      <FormField label={SECRET_LABEL[auth.type]} hint={secretHint(keepsSecret, movedHost)}>
        {(props) => (
          <input
            {...props}
            type="password"
            value={value.secret}
            onChange={(event) => set('secret', event.target.value)}
            required={!keepsSecret}
            autoComplete="off"
          />
        )}
      </FormField>
    );

  return (
    <>
      <FormField label="Base URL" hint="No ?query here: add query parameters below.">
        {(props) => (
          <input
            {...props}
            type="url"
            className="mono"
            placeholder="https://api.example.com/v2"
            value={value.baseUrl}
            onChange={(event) => set('baseUrl', event.target.value)}
            spellCheck={false}
            required
          />
        )}
      </FormField>

      <div className="field">
        <span className="field-label" id={authLabelId}>
          Authentication
        </span>
        <fieldset className="segmented segmented-grid" aria-labelledby={authLabelId}>
          {AUTH_OPTIONS.map((option) => (
            <label key={option.type} className={auth.type === option.type ? 'is-selected' : undefined}>
              <input
                type="radio"
                name={authRadioName}
                checked={auth.type === option.type}
                onChange={() => set('auth', defaultAuth(option.type))}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      </div>
      {auth.type !== 'none' && (
        <div className="form-grid">
          {auth.type === 'basic' && (
            <FormField label="Username">
              {(props) => (
                <input {...props} value={auth.username} onChange={(event) => set('auth', { ...auth, username: event.target.value })} required autoComplete="off" />
              )}
            </FormField>
          )}
          {auth.type === 'apiKeyHeader' && (
            <FormField label="Header name">
              {(props) => (
                <input
                  {...props}
                  className="mono"
                  value={auth.header}
                  onChange={(event) => set('auth', { ...auth, header: event.target.value })}
                  spellCheck={false}
                  required
                />
              )}
            </FormField>
          )}
          {auth.type === 'apiKeyQuery' && (
            <FormField label="Parameter name">
              {(props) => (
                <input
                  {...props}
                  className="mono"
                  value={auth.param}
                  onChange={(event) => set('auth', { ...auth, param: event.target.value })}
                  spellCheck={false}
                  required
                />
              )}
            </FormField>
          )}
          {secretField}
        </div>
      )}

      <KeyValueEditor
        legend="Headers"
        itemLabel="header"
        namePlaceholder="X-Tenant"
        valuePlaceholder="acme"
        pairs={value.headers}
        onChange={(headers) => set('headers', headers)}
        hint={NOT_SECRET_HINT}
      />
      <KeyValueEditor
        legend="Query params"
        itemLabel="parameter"
        namePlaceholder="locale"
        valuePlaceholder="en"
        pairs={value.query}
        onChange={(query) => set('query', query)}
        hint={`Sent to every endpoint. ${NOT_SECRET_HINT}`}
      />

      <FormField
        label="Seconds between requests"
        hint="0 means no limit. A job’s source and its lookups on this API share it. On a 429 or 503 answer, Syncforge waits as Retry-After says and tries again, up to 3 times."
      >
        {(props) => (
          <NumberInput
            {...props}
            min={0}
            max={3600}
            step="any"
            value={value.minIntervalSeconds}
            onChange={(seconds) => set('minIntervalSeconds', seconds)}
            required
          />
        )}
      </FormField>

      <fieldset className="endpoints">
        <legend>Endpoints</legend>
        <p className="field-hint">Each endpoint is a list of records that jobs and lookups can read, like a table.</p>
        {value.endpoints.map((endpoint, index) => (
          <EndpointEditor
            key={endpointKeys[index]}
            index={index}
            endpoint={endpoint}
            probeConfig={probeConfig}
            connectionId={connection?.id}
            canRemove={value.endpoints.length > 1}
            onChange={(next) => setEndpoint(index, next)}
            onRemove={() => removeEndpoint(index)}
          />
        ))}
        <div>
          <button type="button" className="btn btn-quiet" onClick={addEndpoint} disabled={value.endpoints.length >= MAX_ENDPOINTS}>
            <Icon name="plus" /> Add endpoint
          </button>
        </div>
      </fieldset>
    </>
  );
}

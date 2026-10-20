import { FormEvent, useId, useState } from 'react';
import { api } from '../api/client';
import type { Connection, ConnectionConfig, ConnectionKind, ConnectionTestResult } from '../api/types';
import { ErrorNotice, Hint } from '../components/Feedback';
import { FormField } from '../components/FormField';
import { HeaderList } from '../components/HeaderList';
import { KIND_LABEL } from '../lib/format';
import { HttpConnectionFields, type HttpSettings, httpNumberProblem, initialHttpSettings } from './HttpConnectionFields';

interface FormState {
  name: string;
  kind: ConnectionKind;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  ssl: 'disable' | 'require' | 'verify-full';
  uri: string;
  endpoint: string;
  key: string;
  allowSelfSignedCert: boolean;
  delimiter: CsvDelimiter;
  http: HttpSettings;
}

type CsvDelimiter = Extract<ConnectionConfig, { kind: 'csv' }>['delimiter'];

const KINDS: ConnectionKind[] = ['postgres', 'mysql', 'mongo', 'cosmos', 'csv', 'http'];

const DELIMITERS: { value: CsvDelimiter; label: string }[] = [
  { value: 'auto', label: 'Auto-detect' },
  { value: ',', label: 'Comma' },
  { value: ';', label: 'Semicolon' },
  { value: '\t', label: 'Tab' },
];

function delimiterOf(value: unknown): CsvDelimiter {
  return DELIMITERS.find((option) => option.value === value)?.value ?? 'auto';
}

/** Relational databases share one form: host, port, database, user, password, TLS. */
const DEFAULT_PORT: Partial<Record<ConnectionKind, string>> = { postgres: '5432', mysql: '3306' };

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

function initialState(connection?: Connection): FormState {
  const s = connection?.settings ?? {};
  return {
    name: connection?.name ?? '',
    kind: connection?.kind ?? 'postgres',
    host: text(s.host, 'localhost'),
    port: text(s.port, DEFAULT_PORT[connection?.kind ?? 'postgres'] ?? '5432'),
    database: text(s.database, ''),
    user: text(s.user, ''),
    password: '',
    ssl: (s.ssl as FormState['ssl']) ?? 'disable',
    uri: '',
    endpoint: text(s.endpoint, 'https://localhost:8081'),
    key: '',
    allowSelfSignedCert: Boolean(s.allowSelfSignedCert),
    delimiter: delimiterOf(s.delimiter),
    http: initialHttpSettings(connection),
  };
}

function toConfig(state: FormState): ConnectionConfig {
  switch (state.kind) {
    case 'postgres':
    case 'mysql':
      return {
        kind: state.kind,
        host: state.host,
        port: Number(state.port),
        database: state.database,
        user: state.user,
        password: state.password,
        ssl: state.ssl,
      };
    case 'mongo':
      return { kind: 'mongo', uri: state.uri, database: state.database };
    case 'cosmos':
      return {
        kind: 'cosmos',
        endpoint: state.endpoint,
        key: state.key,
        database: state.database,
        allowSelfSignedCert: state.allowSelfSignedCert,
      };
    case 'csv':
      return { kind: 'csv', delimiter: state.delimiter };
    case 'http':
      return { kind: 'http', ...state.http };
  }
}

export function ConnectionForm({ connection, onSaved }: { connection?: Connection; onSaved: (saved: Connection) => void }) {
  const [state, setState] = useState(() => initialState(connection));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult>();
  const [error, setError] = useState<unknown>();
  const delimiterLabelId = useId();

  const keepsSecret = Boolean(connection?.hasSecret && connection.kind === state.kind);
  const update = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setState((previous) => ({ ...previous, [field]: value }));
    setTestResult(undefined);
  };

  // Switching between PostgreSQL and MySQL swaps a default port the user has not changed.
  const changeKind = (kind: ConnectionKind) =>
    setState((previous) => {
      const portIsDefault = Object.values(DEFAULT_PORT).includes(previous.port);
      return { ...previous, kind, port: portIsDefault ? (DEFAULT_PORT[kind] ?? previous.port) : previous.port };
    });

  const test = async () => {
    // A blank number field would be sent as null; say which one instead of a schema error.
    const problem = state.kind === 'http' ? httpNumberProblem(state.http) : undefined;
    setError(problem && new Error(problem));
    if (problem) return;
    setTesting(true);
    try {
      setTestResult(await api.connections.test(toConfig(state), connection?.id));
    } catch (caught) {
      setError(caught);
    } finally {
      setTesting(false);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const input = { name: state.name, config: toConfig(state) };
      onSaved(connection ? await api.connections.update(connection.id, input) : await api.connections.create(input));
    } catch (caught) {
      setError(caught);
      setSaving(false);
    }
  };

  const secretHint = keepsSecret ? 'Leave blank to keep the saved value.' : undefined;

  return (
    <form className="form" onSubmit={save}>
      <FormField label="Name" hint="How this database appears in jobs, e.g. “Legacy orders (staging)”.">
        {(props) => <input {...props} value={state.name} onChange={(e) => update('name', e.target.value)} required maxLength={80} />}
      </FormField>

      <fieldset className="segmented segmented-grid" aria-label="Database type">
        {KINDS.map((kind) => (
          <label key={kind} className={state.kind === kind ? 'is-selected' : undefined}>
            <input type="radio" name="kind" value={kind} checked={state.kind === kind} onChange={() => changeKind(kind)} />
            {KIND_LABEL[kind]}
          </label>
        ))}
      </fieldset>

      {(state.kind === 'postgres' || state.kind === 'mysql') && (
        <div className="form-grid">
          <FormField label="Host">
            {(props) => <input {...props} value={state.host} onChange={(e) => update('host', e.target.value)} required />}
          </FormField>
          <FormField label="Port">
            {(props) => (
              <input {...props} type="number" min={1} max={65535} value={state.port} onChange={(e) => update('port', e.target.value)} required />
            )}
          </FormField>
          <FormField label="Database">
            {(props) => <input {...props} value={state.database} onChange={(e) => update('database', e.target.value)} required />}
          </FormField>
          <FormField label="User">
            {(props) => <input {...props} value={state.user} onChange={(e) => update('user', e.target.value)} required autoComplete="off" />}
          </FormField>
          <FormField label="Password" hint={secretHint}>
            {(props) => (
              <input {...props} type="password" value={state.password} onChange={(e) => update('password', e.target.value)} autoComplete="new-password" />
            )}
          </FormField>
          <FormField label="TLS">
            {(props) => (
              <select {...props} value={state.ssl} onChange={(e) => update('ssl', e.target.value as FormState['ssl'])}>
                <option value="disable">Off</option>
                <option value="require">Required, any certificate</option>
                <option value="verify-full">Required, verified certificate</option>
              </select>
            )}
          </FormField>
        </div>
      )}

      {state.kind === 'mongo' && (
        <div className="form-grid">
          <FormField label="Connection string" wide hint={secretHint ?? 'Stored encrypted. Includes credentials, e.g. mongodb://user:pass@host:27017'}>
            {(props) => (
              <input
                {...props}
                type="password"
                value={state.uri}
                onChange={(e) => update('uri', e.target.value)}
                placeholder="mongodb://…"
                required={!keepsSecret}
                autoComplete="off"
              />
            )}
          </FormField>
          <FormField label="Database">
            {(props) => <input {...props} value={state.database} onChange={(e) => update('database', e.target.value)} required />}
          </FormField>
        </div>
      )}

      {state.kind === 'cosmos' && (
        <div className="form-grid">
          <FormField label="Endpoint" wide>
            {(props) => <input {...props} type="url" value={state.endpoint} onChange={(e) => update('endpoint', e.target.value)} required />}
          </FormField>
          <FormField label="Key" hint={secretHint}>
            {(props) => (
              <input {...props} type="password" value={state.key} onChange={(e) => update('key', e.target.value)} required={!keepsSecret} autoComplete="off" />
            )}
          </FormField>
          <FormField label="Database">
            {(props) => <input {...props} value={state.database} onChange={(e) => update('database', e.target.value)} required />}
          </FormField>
          <label className="checkbox field-wide">
            <input type="checkbox" checked={state.allowSelfSignedCert} onChange={(e) => update('allowSelfSignedCert', e.target.checked)} />
            Accept a self-signed certificate (local emulator only)
          </label>
        </div>
      )}

      {state.kind === 'csv' && (
        <div className="field">
          <span className="field-label" id={delimiterLabelId}>
            Delimiter
          </span>
          <fieldset className="segmented" aria-labelledby={delimiterLabelId}>
            {DELIMITERS.map((option) => (
              <label key={option.label} className={state.delimiter === option.value ? 'is-selected' : undefined}>
                <input
                  type="radio"
                  name="delimiter"
                  value={option.value}
                  checked={state.delimiter === option.value}
                  onChange={() => update('delimiter', option.value)}
                />
                {option.label}
              </label>
            ))}
          </fieldset>
          <Hint>Upload files after saving the connection.</Hint>
        </div>
      )}

      {state.kind === 'http' && (
        <HttpConnectionFields value={state.http} onChange={(http) => update('http', http)} connection={connection} />
      )}

      {testResult &&
        (testResult.ok ? (
          <>
            <Hint>Connected in {testResult.latencyMs} ms.</Hint>
            <HeaderList headers={testResult.rateLimit} label="Rate-limit headers" />
          </>
        ) : (
          <ErrorNotice title="Connection failed" error={new Error(testResult.message)} />
        ))}
      <ErrorNotice error={error} />

      <div className="form-actions">
        {state.kind !== 'csv' && (
          <button type="button" className="btn" onClick={test} disabled={testing || saving}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : connection ? 'Save changes' : 'Add connection'}
        </button>
      </div>
    </form>
  );
}

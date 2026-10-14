import { useCallback, useState } from 'react';
import { api } from '../api/client';
import type { Connection, ConnectionConfig, ConnectionTestResult } from '../api/types';
import { Drawer } from '../components/Drawer';
import { EmptyState, ErrorNotice, Loading } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { KindBadge } from '../components/KindBadge';
import { PageHeader } from '../components/PageHeader';
import { useAsync } from '../hooks/useAsync';
import { ConnectionForm } from './ConnectionForm';
import { CsvFilesPanel } from './CsvFilesPanel';

const SECRET_FIELD = { postgres: 'password', mysql: 'password', mongo: 'uri', cosmos: 'key', csv: null } as const;

type Editing = { mode: 'new' } | { mode: 'edit'; connection: Connection } | undefined;

export function ConnectionsPage() {
  const connections = useAsync(() => api.connections.list(), []);
  const [editing, setEditing] = useState<Editing>();
  const [tests, setTests] = useState<Record<string, ConnectionTestResult | 'pending'>>({});
  const [actionError, setActionError] = useState<unknown>();
  const close = useCallback(() => setEditing(undefined), []);

  const test = async (connection: Connection) => {
    setTests((previous) => ({ ...previous, [connection.id]: 'pending' }));
    // A blank secret tells the engine to use the saved one.
    const secretField = SECRET_FIELD[connection.kind];
    const config = (secretField ? { ...connection.settings, [secretField]: '' } : connection.settings) as ConnectionConfig;
    try {
      const result = await api.connections.test(config, connection.id);
      setTests((previous) => ({ ...previous, [connection.id]: result }));
    } catch (error) {
      setTests((previous) => ({ ...previous, [connection.id]: { ok: false, message: (error as Error).message } }));
    }
  };

  const remove = async (connection: Connection) => {
    const confirmed = window.confirm(`Delete “${connection.name}”? Jobs that use it will stop working until you pick another connection.`);
    if (!confirmed) return;
    try {
      await api.connections.remove(connection.id);
      await connections.reload();
    } catch (error) {
      setActionError(error);
    }
  };

  return (
    <>
      <PageHeader
        title="Connections"
        description="Databases Syncforge can read from and write to. Credentials are encrypted on this machine and never leave it."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setEditing({ mode: 'new' })}>
            <Icon name="plus" /> Add connection
          </button>
        }
      />

      <ErrorNotice error={connections.error ?? actionError} />
      {connections.loading && !connections.data && <Loading />}

      {connections.data?.length === 0 && (
        <EmptyState
          title="No connections yet"
          action={
            <button type="button" className="btn btn-primary" onClick={() => setEditing({ mode: 'new' })}>
              <Icon name="plus" /> Add your first connection
            </button>
          }
        >
          Add the database you migrate from, then the one you migrate to.
        </EmptyState>
      )}

      <ul className="connection-list">
        {connections.data?.map((connection) => {
          const result = tests[connection.id];
          return (
            <li key={connection.id} className="connection-item">
              <div className="connection-main">
                <div className="connection-title">
                  <h2>{connection.name}</h2>
                  <KindBadge kind={connection.kind} />
                </div>
                <code className="connection-summary">{connection.summary}</code>
                {result && result !== 'pending' && (
                  <p className={`connection-test ${result.ok ? 'is-ok' : 'is-failed'}`} role="status">
                    {result.ok ? `Reachable in ${result.latencyMs} ms` : result.message}
                  </p>
                )}
              </div>
              <div className="connection-actions">
                {connection.kind !== 'csv' && (
                  <button type="button" className="btn btn-quiet" onClick={() => test(connection)} disabled={result === 'pending'}>
                    <Icon name="plug" /> {result === 'pending' ? 'Testing…' : 'Test'}
                  </button>
                )}
                <button type="button" className="btn btn-quiet" onClick={() => setEditing({ mode: 'edit', connection })}>
                  <Icon name="edit" /> Edit
                </button>
                <button type="button" className="btn btn-quiet btn-danger" onClick={() => remove(connection)}>
                  <Icon name="trash" /> Delete
                </button>
              </div>
              {connection.kind === 'csv' && <CsvFilesPanel connectionId={connection.id} />}
            </li>
          );
        })}
      </ul>

      {editing && (
        <Drawer title={editing.mode === 'new' ? 'Add connection' : `Edit ${editing.connection.name}`} onClose={close}>
          <ConnectionForm
            connection={editing.mode === 'edit' ? editing.connection : undefined}
            onSaved={() => {
              close();
              void connections.reload();
            }}
          />
        </Drawer>
      )}
    </>
  );
}

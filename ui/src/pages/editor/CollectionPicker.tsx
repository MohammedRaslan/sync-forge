import { ChangeEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import { CsvUploadError } from '../../components/CsvUploadError';
import { ErrorNotice, Hint } from '../../components/Feedback';
import { Icon } from '../../components/Icon';
import { useAsync } from '../../hooks/useAsync';

const MAX_SHOWN = 200;

/** Uploads a file to the connection and resolves to the name it was saved under. */
export type CollectionUpload = (file: File, onProgress: (fraction: number) => void) => Promise<string>;

/** An upload in progress, or one that failed and stays shown until the next one. */
interface UploadState {
  name: string;
  progress: number;
  error?: unknown;
}

/**
 * Type to filter, click to choose. Targets may name a collection that does not exist yet.
 * With `onUpload` (CSV connections) the collections are files, and a new one can be uploaded and chosen here.
 */
export function CollectionPicker({ connectionId, value, onChange, allowNew = false, label, onUpload }: {
  connectionId: string;
  value: string;
  onChange: (collection: string) => void;
  allowNew?: boolean;
  label: string;
  onUpload?: CollectionUpload;
}) {
  const inputId = useId();
  const [focused, setFocused] = useState(false);
  const [upload, setUpload] = useState<UploadState>();
  const filePicker = useRef<HTMLInputElement>(null);
  // Callers key the picker by connection, so a connection change unmounts it; an upload that finishes
  // afterwards must not pick its file on the newly chosen connection.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const collections = useAsync(
    () => (connectionId ? api.connections.collections(connectionId) : Promise.resolve([])),
    [connectionId],
  );

  const names = useMemo(() => collections.data?.map((collection) => collection.name) ?? [], [collections.data]);
  const exists = names.includes(value);
  const matches = useMemo(() => {
    const query = exists ? '' : value.trim().toLowerCase();
    return names.filter((name) => name.toLowerCase().includes(query)).slice(0, MAX_SHOWN);
  }, [names, value, exists]);

  const picked = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared so picking the same file again still fires a change.
    event.target.value = '';
    if (!file || !onUpload) return;
    setUpload({ name: file.name, progress: 0 });
    try {
      const saved = await onUpload(file, (progress) => mounted.current && setUpload({ name: file.name, progress }));
      if (!mounted.current) return;
      setUpload(undefined);
      await collections.reload();
      if (mounted.current) onChange(saved);
    } catch (error) {
      if (mounted.current) setUpload({ name: file.name, progress: 0, error });
    }
  };

  if (!connectionId) return null;
  // Once a valid collection is chosen the list folds away; focusing the picker reopens it.
  const showList = matches.length > 0 && (focused || !exists);

  return (
    <div
      className="picker"
      onFocus={() => setFocused(true)}
      onBlur={(event) => !event.currentTarget.contains(event.relatedTarget as Node | null) && setFocused(false)}
    >
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        className="mono"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={collections.loading ? 'Loading…' : allowNew ? 'Search or type a new name' : 'Search'}
        autoComplete="off"
        spellCheck={false}
      />
      <ErrorNotice error={collections.error} />
      {value && !exists && !collections.loading && (
        <p className="field-hint">
          {allowNew
            ? 'Not found on this connection. MongoDB creates it on first write; PostgreSQL and MySQL tables and Cosmos DB containers must exist.'
            : onUpload
              ? 'Choose a file from the list, or upload it.'
              : 'Choose a collection from the list.'}
        </p>
      )}
      {onUpload && collections.data?.length === 0 && <Hint>No files uploaded yet.</Hint>}
      {showList && (
        <ul className="picker-list" role="listbox" aria-label={label}>
          {matches.map((name) => (
            <li key={name}>
              <button
                type="button"
                role="option"
                aria-selected={name === value}
                className={name === value ? 'is-selected' : undefined}
                // Keeps focus (and the list) in place until the click lands.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(name);
                  setFocused(false);
                }}
              >
                {name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {onUpload && (
        <>
          <div>
            <button type="button" className="btn btn-quiet" disabled={upload && !upload.error} onClick={() => filePicker.current?.click()}>
              <Icon name="upload" /> Upload a file
            </button>
          </div>
          <input ref={filePicker} type="file" accept=".csv,text/csv" hidden onChange={picked} />
          {upload && (
            <div className="upload-row">
              <code className="upload-name">{upload.name}</code>
              {upload.error ? (
                <p className="upload-message" role="alert">
                  <CsvUploadError error={upload.error} />
                </p>
              ) : (
                <>
                  <span className="upload-percent">{Math.round(upload.progress * 100)}%</span>
                  <div
                    className="upload-bar"
                    role="progressbar"
                    aria-label={`Uploading ${upload.name}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(upload.progress * 100)}
                  >
                    <span style={{ width: `${upload.progress * 100}%` }} />
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

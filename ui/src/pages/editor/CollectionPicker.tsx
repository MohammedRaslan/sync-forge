import { useId, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { ErrorNotice } from '../../components/Feedback';
import { useAsync } from '../../hooks/useAsync';

const MAX_SHOWN = 200;

/** Type to filter, click to choose. Targets may name a collection that does not exist yet. */
export function CollectionPicker({ connectionId, value, onChange, allowNew = false, label }: {
  connectionId: string;
  value: string;
  onChange: (collection: string) => void;
  allowNew?: boolean;
  label: string;
}) {
  const inputId = useId();
  const [focused, setFocused] = useState(false);
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
            ? 'Not found on this connection. MongoDB creates it on first write; Postgres tables and Cosmos DB containers must exist.'
            : 'Choose a collection from the list.'}
        </p>
      )}
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
    </div>
  );
}

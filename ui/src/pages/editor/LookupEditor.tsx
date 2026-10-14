import { useEffect, useState } from 'react';
import type { Connection, FieldInfo, Lookup } from '../../api/types';
import { FormField } from '../../components/FormField';
import { Icon } from '../../components/Icon';
import { uploadCsvFileAsNamed } from '../../lib/csvUpload';
import { KIND_LABEL } from '../../lib/format';
import { CollectionPicker } from './CollectionPicker';
import { SourceFieldList } from './SourceFieldList';

/** Names the editor gives new lookups; replaced by the collection name once one is chosen. */
export const PLACEHOLDER_NAME = /^lookup\d*$/;

const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** "public.customers" → "customers": a valid lookup name derived from a collection name. */
export function lookupNameFor(collection: string): string {
  const name = (collection.split('.').pop() ?? '').replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(name) ? name : `_${name}`;
}

/**
 * One lookup: where to find the related row, how it matches the source row, and which of
 * its fields to map. Its fields appear under the lookup name, e.g. customer.email.
 */
export function LookupEditor({ lookup, index, connections, fields, selected, onChange, onRemove, onToggleField, onSelectAll }: {
  lookup: Lookup;
  index: number;
  connections: Connection[];
  /** Fields of the lookup collection, without the lookup-name prefix. */
  fields: FieldInfo[];
  selected: ReadonlySet<string>;
  onChange: (lookup: Lookup) => void;
  onRemove: () => void;
  onToggleField: (field: FieldInfo) => void;
  onSelectAll: (fields: FieldInfo[], select: boolean) => void;
}) {
  const fieldListId = `lookup-${index}-fields`;
  // The name is committed on blur, so mappings that read it are renamed once, from one valid name to another.
  const [name, setName] = useState(lookup.as);
  useEffect(() => setName(lookup.as), [lookup.as]);
  const commitName = () => {
    const next = name.trim();
    if (next !== lookup.as && VALID_NAME.test(next)) onChange({ ...lookup, as: next });
    else setName(lookup.as);
  };
  const isCsv = connections.find((c) => c.id === lookup.connectionId)?.kind === 'csv';
  const prefixed = fields.map((field) => ({ ...field, path: `${lookup.as}.${field.path}`, primaryKey: false }));
  const setPair = (pairIndex: number, pair: Lookup['on'][number] | undefined) =>
    onChange({
      ...lookup,
      on: pair ? lookup.on.map((p, i) => (i === pairIndex ? pair : p)) : lookup.on.filter((_, i) => i !== pairIndex),
    });

  return (
    <div className="lookup">
      <div className="lookup-head">
        <FormField
          label="Name"
          hint={
            VALID_NAME.test(name.trim()) ? (
              <>
                Map its fields as <code>{name.trim()}.field</code>
              </>
            ) : (
              'Letters, digits and _, starting with a letter'
            )
          }
        >
          {(props) => (
            <input
              {...props}
              className="mono"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={commitName}
              onKeyDown={(event) => event.key === 'Enter' && (event.preventDefault(), commitName())}
              spellCheck={false}
              required
            />
          )}
        </FormField>
        <FormField label="Connection">
          {(props) => (
            <select
              {...props}
              value={lookup.connectionId}
              onChange={(event) => onChange({ ...lookup, connectionId: event.target.value, collection: '' })}
            >
              <option value="">Choose a connection</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({KIND_LABEL[c.kind]})
                </option>
              ))}
            </select>
          )}
        </FormField>
        <button type="button" className="icon-button lookup-remove" aria-label={`Remove lookup ${lookup.as}`} onClick={onRemove}>
          <Icon name="x" />
        </button>
      </div>

      <CollectionPicker
        key={lookup.connectionId}
        label={isCsv ? 'File' : 'Table or collection'}
        connectionId={lookup.connectionId}
        onUpload={isCsv ? (file, onProgress) => uploadCsvFileAsNamed(lookup.connectionId, file, onProgress) : undefined}
        value={lookup.collection}
        onChange={(collection) =>
          onChange({ ...lookup, collection, as: PLACEHOLDER_NAME.test(lookup.as) && collection ? lookupNameFor(collection) : lookup.as })
        }
      />

      <fieldset className="lookup-match">
        <legend>Match when</legend>
        {lookup.on.map((pair, pairIndex) => (
          <div key={pairIndex} className="match-row">
            <input
              className="mono match-source"
              list="source-field-options"
              aria-label={`Source field ${pairIndex + 1} for ${lookup.as}`}
              placeholder="source field"
              value={pair.source}
              onChange={(event) => setPair(pairIndex, { ...pair, source: event.target.value })}
              spellCheck={false}
            />
            <span className="match-equals" aria-hidden="true">
              =
            </span>
            <input
              className="mono"
              list={fieldListId}
              aria-label={`${lookup.as} field ${pairIndex + 1}`}
              placeholder={`${lookup.as || 'lookup'} field`}
              value={pair.lookup}
              onChange={(event) => setPair(pairIndex, { ...pair, lookup: event.target.value })}
              spellCheck={false}
            />
            <button
              type="button"
              className="icon-button"
              aria-label={`Remove match field ${pairIndex + 1}`}
              disabled={lookup.on.length === 1}
              onClick={() => setPair(pairIndex, undefined)}
            >
              <Icon name="x" />
            </button>
          </div>
        ))}
        <button type="button" className="link-button" onClick={() => onChange({ ...lookup, on: [...lookup.on, { source: '', lookup: '' }] })}>
          Match on another field too
        </button>
        <datalist id={fieldListId}>
          {fields.map((field) => <option key={field.path} value={field.path} />)}
        </datalist>
      </fieldset>

      <label className="checkbox">
        <input type="checkbox" checked={lookup.required} onChange={(event) => onChange({ ...lookup, required: event.target.checked })} />
        A source row without a match is a row error (otherwise its {lookup.as || 'lookup'} fields are empty)
      </label>

      <SourceFieldList
        fields={prefixed}
        selected={selected}
        onToggle={onToggleField}
        onSelectAll={(select) => onSelectAll(prefixed, select)}
      />
    </div>
  );
}

import type { FieldInfo } from '../../api/types';

/** Ticking a field adds a mapping for it; unticking removes every mapping that reads it. */
export function SourceFieldList({ fields, selected, onToggle, onSelectAll }: {
  fields: FieldInfo[];
  selected: ReadonlySet<string>;
  onToggle: (field: FieldInfo) => void;
  onSelectAll: (select: boolean) => void;
}) {
  if (fields.length === 0) return null;
  const selectedCount = fields.filter((field) => selected.has(field.path)).length;
  const allSelected = selectedCount === fields.length;

  return (
    <div className="field-list">
      <div className="field-list-head">
        <span>
          {selectedCount} of {fields.length} fields selected
        </span>
        <button type="button" className="link-button" onClick={() => onSelectAll(!allSelected)}>
          {allSelected ? 'Clear selection' : 'Select all'}
        </button>
      </div>
      <ul>
        {fields.map((field) => (
          <li key={field.path}>
            <label className={selected.has(field.path) ? 'is-selected' : undefined}>
              <input type="checkbox" checked={selected.has(field.path)} onChange={() => onToggle(field)} />
              <code className="field-path">{field.path}</code>
              <span className="field-type">{field.type}</span>
              {field.primaryKey && <span className="tag tag-key">key</span>}
              {field.presence !== undefined && field.presence < 1 && (
                <span className="tag" title="Share of sampled documents that contain this field">
                  in {Math.round(field.presence * 100)}%
                </span>
              )}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

import type { FieldMapping, TransformInfo } from '../../api/types';
import { Icon } from '../../components/Icon';

export function MappingTable({ mappings, keyFields, transforms, onChange, onToggleKey, onAdd }: {
  mappings: FieldMapping[];
  keyFields: readonly string[];
  transforms: TransformInfo[];
  onChange: (index: number, mapping: FieldMapping | undefined) => void;
  onToggleKey: (targetField: string) => void;
  onAdd: () => void;
}) {
  const byName = new Map(transforms.map((transform) => [transform.name, transform]));

  return (
    <div className="mapping">
      {mappings.length > 0 && (
        <div className="mapping-head" aria-hidden="true">
          <span>Source field</span>
          <span>Transform</span>
          <span />
          <span>Target field</span>
          <span>Key</span>
          <span />
        </div>
      )}
      <ol className="mapping-rows">
        {mappings.map((mapping, index) => {
          const transform = byName.get(mapping.transform);
          const isKey = keyFields.includes(mapping.to);
          const label = mapping.to || `row ${index + 1}`;
          return (
            <li key={index} className="mapping-row">
              <input
                className="mono"
                list="source-field-options"
                aria-label={`Source field for ${label}`}
                value={mapping.from ?? ''}
                placeholder={transform?.sourceField === 'none' ? 'Not used' : 'field'}
                disabled={transform?.sourceField === 'none'}
                onChange={(event) => onChange(index, { ...mapping, from: event.target.value || undefined })}
                spellCheck={false}
              />
              <div className="mapping-transform">
                <select
                  aria-label={`Transform for ${label}`}
                  value={mapping.transform}
                  onChange={(event) => {
                    const next = byName.get(event.target.value);
                    onChange(index, {
                      ...mapping,
                      transform: event.target.value,
                      argument: next?.argument ? mapping.argument : undefined,
                      from: next?.sourceField === 'none' ? undefined : mapping.from,
                    });
                  }}
                >
                  {transforms.map((option) => (
                    <option key={option.name} value={option.name} title={option.description}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {transform?.argument && (
                  <input
                    className={transform.name === 'expression' ? 'mono' : undefined}
                    aria-label={`${transform.argument.label} for ${label}`}
                    value={mapping.argument ?? ''}
                    placeholder={transform.argument.placeholder}
                    onChange={(event) => onChange(index, { ...mapping, argument: event.target.value })}
                    spellCheck={false}
                  />
                )}
              </div>
              <span className="mapping-arrow" aria-hidden="true">
                →
              </span>
              <input
                className="mono"
                list="target-field-options"
                aria-label={`Target field for row ${index + 1}`}
                value={mapping.to}
                placeholder="field"
                onChange={(event) => onChange(index, { ...mapping, to: event.target.value })}
                spellCheck={false}
              />
              <button
                type="button"
                className={`icon-button key-toggle${isKey ? ' is-on' : ''}`}
                aria-pressed={isKey}
                aria-label={`Match rows on ${label}`}
                title="Match target rows on this field"
                disabled={!mapping.to}
                onClick={() => onToggleKey(mapping.to)}
              >
                <Icon name="key" />
              </button>
              <button type="button" className="icon-button" aria-label={`Remove mapping for ${label}`} onClick={() => onChange(index, undefined)}>
                <Icon name="x" />
              </button>
            </li>
          );
        })}
      </ol>
      <button type="button" className="btn btn-quiet" onClick={onAdd}>
        <Icon name="plus" /> Add a computed or fixed field
      </button>
    </div>
  );
}

import type { FieldInfo, FilterOp, FilterValueType, SourceFilter } from '../../api/types';
import { Icon } from '../../components/Icon';
import { FILTER_OP_LABEL, FILTER_VALUE_PLACEHOLDER, filterTypeFor } from '../../lib/filters';

const OPS = Object.keys(FILTER_OP_LABEL) as FilterOp[];
const VALUE_TYPES: FilterValueType[] = ['string', 'number', 'date', 'boolean'];

/** "Only rows where …": conditions the database applies, so only matching rows are read. */
export function SourceFilters({ filters, fields, onChange }: {
  filters: SourceFilter[];
  /** Fields of the source itself, offered as suggestions. */
  fields: FieldInfo[];
  onChange: (filters: SourceFilter[]) => void;
}) {
  const setFilter = (index: number, filter: SourceFilter | undefined) =>
    onChange(filter ? filters.map((f, i) => (i === index ? filter : f)) : filters.filter((_, i) => i !== index));

  // Picking a known field also picks the value type that fits it.
  const setField = (index: number, field: string) => {
    const known = fields.find((info) => info.path === field);
    const type = known ? filterTypeFor(known.type) : filters[index].type;
    const value = type === 'boolean' && filters[index].type !== 'boolean' ? 'true' : filters[index].value;
    setFilter(index, { ...filters[index], field, type, value });
  };

  return (
    <fieldset className="source-filters">
      <legend>Only rows where</legend>
      {filters.length === 0 && <p className="field-hint">Every row is read. Add a condition to read only some, e.g. created_at after a date.</p>}
      {filters.map((filter, index) => {
        const label = `condition ${index + 1}`;
        return (
          <div key={index} className="filter-row">
            <input
              className="mono match-source"
              list="source-own-field-options"
              aria-label={`Field for ${label}`}
              placeholder="field"
              value={filter.field}
              onChange={(event) => setField(index, event.target.value)}
              spellCheck={false}
            />
            <select
              aria-label={`Comparison for ${label}`}
              value={filter.op}
              onChange={(event) => setFilter(index, { ...filter, op: event.target.value as FilterOp })}
            >
              {OPS.map((op) => (
                <option key={op} value={op}>
                  {FILTER_OP_LABEL[op]}
                </option>
              ))}
            </select>
            {filter.type === 'boolean' ? (
              <select
                aria-label={`Value for ${label}`}
                value={filter.value}
                onChange={(event) => setFilter(index, { ...filter, value: event.target.value })}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                className="mono"
                aria-label={`Value for ${label}`}
                placeholder={FILTER_VALUE_PLACEHOLDER[filter.type]}
                value={filter.value}
                onChange={(event) => setFilter(index, { ...filter, value: event.target.value })}
                spellCheck={false}
              />
            )}
            <select
              aria-label={`Value type for ${label}`}
              value={filter.type}
              onChange={(event) => {
                const type = event.target.value as FilterValueType;
                setFilter(index, { ...filter, type, value: type === 'boolean' ? 'true' : filter.value });
              }}
            >
              {VALUE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <button type="button" className="icon-button" aria-label={`Remove ${label}`} onClick={() => setFilter(index, undefined)}>
              <Icon name="x" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="link-button"
        onClick={() => onChange([...filters, { field: '', op: 'gt', type: 'string', value: '' }])}
      >
        Add a condition
      </button>
      <datalist id="source-own-field-options">
        {fields.map((field) => <option key={field.path} value={field.path} />)}
      </datalist>
    </fieldset>
  );
}

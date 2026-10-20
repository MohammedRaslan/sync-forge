import type { ReactNode } from 'react';
import type { HeaderPair } from '../api/types';
import { Icon } from './Icon';

/** Rows of name and value, such as request headers or query parameters. The engine validates the names. */
export function KeyValueEditor({ legend, pairs, onChange, itemLabel, namePlaceholder, valuePlaceholder, hint }: {
  legend: string;
  pairs: readonly HeaderPair[];
  onChange: (pairs: HeaderPair[]) => void;
  /** One row's noun, e.g. "header": used in the add button and the row labels. */
  itemLabel: string;
  namePlaceholder: string;
  valuePlaceholder: string;
  hint?: ReactNode;
}) {
  const setPair = (index: number, pair: HeaderPair | undefined) =>
    onChange(pair ? pairs.map((p, i) => (i === index ? pair : p)) : pairs.filter((_, i) => i !== index));

  return (
    <fieldset className="kv-editor">
      <legend>{legend}</legend>
      {pairs.map((pair, index) => {
        const label = `${itemLabel} ${index + 1}`;
        return (
          <div key={index} className="kv-row">
            <input
              className="mono"
              aria-label={`Name of ${label}`}
              placeholder={namePlaceholder}
              value={pair.name}
              onChange={(event) => setPair(index, { ...pair, name: event.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
            <input
              className="mono"
              aria-label={`Value of ${label}`}
              placeholder={valuePlaceholder}
              value={pair.value}
              onChange={(event) => setPair(index, { ...pair, value: event.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
            <button type="button" className="icon-button" aria-label={`Remove ${label}`} onClick={() => setPair(index, undefined)}>
              <Icon name="x" />
            </button>
          </div>
        );
      })}
      <button type="button" className="link-button" onClick={() => onChange([...pairs, { name: '', value: '' }])}>
        Add a {itemLabel}
      </button>
      {hint && <p className="field-hint">{hint}</p>}
    </fieldset>
  );
}

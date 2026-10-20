import type { InputHTMLAttributes } from 'react';

/**
 * A number field that can pass through empty while the user types: empty is NaN and shows as blank,
 * instead of snapping back to 0. Mark it `required` where a blank must not be saved.
 */
export function NumberInput({ value, onChange, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & {
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <input
      {...props}
      type="number"
      value={Number.isNaN(value) ? '' : value}
      onChange={(event) => onChange(event.target.value === '' ? Number.NaN : Number(event.target.value))}
    />
  );
}

import { ReactNode, useId } from 'react';

/** Label, control and hint wired together for screen readers. */
export function FormField({ label, hint, children, wide = false }: {
  label: string;
  hint?: ReactNode;
  wide?: boolean;
  children: (props: { id: string; 'aria-describedby'?: string }) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={`field${wide ? ' field-wide' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children({ id, 'aria-describedby': hintId })}
      {hint && (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
}

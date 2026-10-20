import type { HeaderPair } from '../api/types';

/** Response headers shown back as `name: value`, e.g. the rate-limit headers of an HTTP API. Nothing when empty. */
export function HeaderList({ headers, label }: { headers: readonly HeaderPair[] | undefined; label: string }) {
  if (!headers || headers.length === 0) return null;
  return (
    <ul className="header-list" aria-label={label}>
      {headers.map((header) => (
        <li key={header.name}>
          <code>
            {header.name}: {header.value}
          </code>
        </li>
      ))}
    </ul>
  );
}

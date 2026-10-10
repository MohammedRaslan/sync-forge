/**
 * Helpers for dotted field paths such as "address.city".
 * Relational sources use flat column names, document stores use nested paths;
 * these helpers let the rest of the engine treat both the same way.
 */

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

export function isSafeFieldPath(path: string): boolean {
  if (path.length === 0 || path.includes('$')) return false;
  return path.split('.').every((segment) => segment.length > 0 && !FORBIDDEN_SEGMENTS.has(segment));
}

export function getPath(source: unknown, path: string): unknown {
  if (source === null || typeof source !== 'object') return undefined;
  // A flat key wins, so a column literally named "a.b" still resolves.
  if (Object.prototype.hasOwnProperty.call(source, path)) {
    return (source as Record<string, unknown>)[path];
  }
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  if (!isSafeFieldPath(path)) throw new Error(`Unsafe field path "${path}"`);
  const segments = path.split('.');
  let node = target;
  for (const segment of segments.slice(0, -1)) {
    const next = node[segment];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      node[segment] = {};
    }
    node = node[segment] as Record<string, unknown>;
  }
  node[segments[segments.length - 1]] = value;
}

/** Turns { "a.b": 1, c: 2 } into { a: { b: 1 }, c: 2 }. */
export function unflatten(flat: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(flat)) setPath(result, path, value);
  return result;
}

/** Drops paths already covered by an ancestor ("a" covers "a.b"); MongoDB rejects such projections. */
export function collapsePaths(paths: readonly string[]): string[] {
  const unique = [...new Set(paths)].sort();
  return unique.filter((path) => !unique.some((other) => other !== path && path.startsWith(`${other}.`)));
}

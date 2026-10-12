import { Script, createContext } from 'node:vm';
import { Injectable } from '@nestjs/common';
import { ValidationError } from '../common/errors';
import { normalizeValue } from '../common/values';

export const TRANSFORM_NAMES = [
  'none',
  'string',
  'number',
  'boolean',
  'date',
  'trim',
  'lowercase',
  'uppercase',
  'json',
  'default',
  'constant',
  'expression',
] as const;

export type TransformName = (typeof TRANSFORM_NAMES)[number];
export type TransformFn = (value: unknown, row: Readonly<Record<string, unknown>>) => unknown;

export interface TransformDefinition {
  readonly name: TransformName;
  readonly label: string;
  readonly description: string;
  /** Whether a mapping using this transform reads a source field. */
  readonly sourceField: 'required' | 'optional' | 'none';
  readonly argument?: { readonly label: string; readonly placeholder: string };
  compile(argument: string | undefined): TransformFn;
}

const EXPRESSION_TIMEOUT_MS = 50;
const TRUE_WORDS = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'n', 'off']);

/** Wraps a plain value transform so null/undefined pass through untouched. */
const nullSafe =
  (convert: (value: unknown) => unknown): TransformFn =>
  (value) =>
    value === null || value === undefined ? null : convert(value);

/** "42" → 42, "true" → true, '"x"' → "x", anything that is not JSON stays a string. */
function parseArgument(argument: string): unknown {
  try {
    return JSON.parse(argument);
  } catch {
    return argument;
  }
}

function requireArgument(name: string, argument: string | undefined): string {
  if (argument === undefined || argument.trim() === '') {
    throw new ValidationError(`The "${name}" transform needs a value`);
  }
  return argument;
}

function toText(value: unknown): string {
  const normalized = normalizeValue(value);
  if (normalized instanceof Date) return normalized.toISOString();
  if (typeof normalized === 'object' && normalized !== null) return JSON.stringify(normalized);
  return String(normalized);
}

/**
 * Values created inside the vm sandbox belong to another realm, so `instanceof Date` fails for them.
 * Dates come back as real Dates, also inside arrays and plain objects. Other objects, such as BSON
 * values passed through from the row, are left alone.
 */
function fromSandbox(value: unknown, sandboxObject: object): unknown {
  if (Object.prototype.toString.call(value) === '[object Date]') return new Date((value as Date).getTime());
  if (Array.isArray(value)) return value.map((item) => fromSandbox(item, sandboxObject));
  if (value === null || typeof value !== 'object') return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype && proto !== sandboxObject) return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, fromSandbox(inner, sandboxObject)]));
}

function compileExpression(source: string | undefined): TransformFn {
  const expression = requireArgument('expression', source);
  let script: Script;
  try {
    script = new Script(`(${expression}\n)`, { filename: 'mapping-expression.js' });
  } catch (error) {
    throw new ValidationError(`Invalid expression: ${(error as Error).message}`);
  }
  // One context per mapping, reused for every row. node:vm isolates globals, not privileges:
  // expressions are trusted input written by the people running this local tool.
  const context = createContext({ value: undefined, row: undefined });
  const sandboxObject = new Script('Object.prototype').runInContext(context) as object;
  return (value, row) => {
    context.value = value;
    context.row = row;
    return fromSandbox(script.runInContext(context, { timeout: EXPRESSION_TIMEOUT_MS }), sandboxObject);
  };
}

const DEFINITIONS: readonly TransformDefinition[] = [
  {
    name: 'none',
    label: 'Copy as is',
    description: 'Copies the value unchanged.',
    sourceField: 'required',
    compile: () => (value) => value,
  },
  {
    name: 'string',
    label: 'To text',
    description: 'Converts to text. Dates become ISO strings, objects become JSON.',
    sourceField: 'required',
    compile: () => nullSafe(toText),
  },
  {
    name: 'number',
    label: 'To number',
    description: 'Converts to a number. Empty text becomes null.',
    sourceField: 'required',
    compile: () =>
      nullSafe((value) => {
        const normalized = normalizeValue(value);
        if (typeof normalized === 'string' && normalized.trim() === '') return null;
        const result = Number(normalized);
        if (Number.isNaN(result)) throw new Error(`"${toText(value)}" is not a number`);
        return result;
      }),
  },
  {
    name: 'boolean',
    label: 'To boolean',
    description: 'Accepts true/false, 1/0, yes/no, on/off.',
    sourceField: 'required',
    compile: () =>
      nullSafe((value) => {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        const word = toText(value).trim().toLowerCase();
        if (TRUE_WORDS.has(word)) return true;
        if (FALSE_WORDS.has(word)) return false;
        throw new Error(`"${word}" is not a boolean`);
      }),
  },
  {
    name: 'date',
    label: 'To date',
    description: 'Parses text or epoch milliseconds into a date.',
    sourceField: 'required',
    compile: () =>
      nullSafe((value) => {
        const date = value instanceof Date ? value : new Date(normalizeValue(value) as string | number);
        if (Number.isNaN(date.getTime())) throw new Error(`"${toText(value)}" is not a valid date`);
        return date;
      }),
  },
  {
    name: 'trim',
    label: 'Trim spaces',
    description: 'Removes leading and trailing whitespace.',
    sourceField: 'required',
    compile: () => nullSafe((value) => toText(value).trim()),
  },
  {
    name: 'lowercase',
    label: 'Lowercase',
    description: 'Converts text to lowercase.',
    sourceField: 'required',
    compile: () => nullSafe((value) => toText(value).toLowerCase()),
  },
  {
    name: 'uppercase',
    label: 'Uppercase',
    description: 'Converts text to uppercase.',
    sourceField: 'required',
    compile: () => nullSafe((value) => toText(value).toUpperCase()),
  },
  {
    name: 'json',
    label: 'To JSON text',
    description: 'Serializes objects and arrays to JSON text.',
    sourceField: 'required',
    compile: () => nullSafe((value) => JSON.stringify(normalizeValue(value))),
  },
  {
    name: 'default',
    label: 'Fallback when empty',
    description: 'Uses the given value when the source is null or missing.',
    sourceField: 'required',
    argument: { label: 'Fallback', placeholder: 'e.g. 0, true or pending' },
    compile: (argument) => {
      const fallback = parseArgument(requireArgument('default', argument));
      return (value) => (value === null || value === undefined ? fallback : value);
    },
  },
  {
    name: 'constant',
    label: 'Fixed value',
    description: 'Writes the same value on every row.',
    sourceField: 'none',
    argument: { label: 'Value', placeholder: 'e.g. "legacy" or 1' },
    compile: (argument) => {
      const constant = parseArgument(requireArgument('constant', argument));
      return () => constant;
    },
  },
  {
    name: 'expression',
    label: 'Expression',
    description: 'A JavaScript expression with access to `value` and the whole source `row`.',
    sourceField: 'optional',
    argument: { label: 'Expression', placeholder: "row.first_name + ' ' + row.last_name" },
    compile: compileExpression,
  },
];

export const TRANSFORM_DEFINITIONS: ReadonlyMap<TransformName, TransformDefinition> = new Map(
  DEFINITIONS.map((definition) => [definition.name, definition]),
);

/** Strategy registry: each transform is a named strategy compiled once per job, applied per row. */
@Injectable()
export class TransformRegistry {
  compile(name: TransformName, argument?: string): TransformFn {
    const definition = TRANSFORM_DEFINITIONS.get(name);
    if (!definition) throw new ValidationError(`Unknown transform "${name}"`);
    return definition.compile(argument);
  }

  describe() {
    return DEFINITIONS.map(({ name, label, description, sourceField, argument }) => ({
      name,
      label,
      description,
      sourceField,
      argument: argument ?? null,
    }));
  }
}

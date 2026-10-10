import { ValidationError, errorMessage } from '../common/errors';
import { getPath } from '../common/paths';
import { Row } from '../connectors/connector.types';
import { FieldMapping } from '../jobs/job.model';
import { TransformFn, TransformRegistry } from '../transforms/transform.registry';

interface CompiledMapping {
  from?: string;
  to: string;
  apply: TransformFn;
}

export class RowMappingError extends Error {
  constructor(
    readonly field: string,
    cause: unknown,
  ) {
    super(`"${field}": ${errorMessage(cause)}`);
    this.name = 'RowMappingError';
  }
}

/** Source fields worth fetching for these mappings, or undefined when an expression may read any field of the row. */
export function sourceFieldsOf(mappings: readonly FieldMapping[]): string[] | undefined {
  if (mappings.some((mapping) => mapping.transform === 'expression')) return undefined;
  const fields = [...new Set(mappings.flatMap((mapping) => (mapping.from ? [mapping.from] : [])))];
  return fields.length > 0 ? fields : undefined;
}

/**
 * Turns a source row into a target row. Compiled once per job (transforms are
 * validated up front), then applied to every row. Output keys are the target
 * field paths; each writer decides how to store them (columns, $set paths, nested JSON).
 */
export class RowMapper {
  private constructor(
    private readonly mappings: readonly CompiledMapping[],
    private readonly specs: readonly FieldMapping[],
  ) {}

  static compile(mappings: readonly FieldMapping[], transforms: TransformRegistry): RowMapper {
    return new RowMapper(
      mappings.map((mapping) => {
        try {
          return {
            from: mapping.from,
            to: mapping.to,
            apply: transforms.compile(mapping.transform, mapping.argument),
          };
        } catch (error) {
          throw new ValidationError(`Mapping to "${mapping.to}": ${errorMessage(error)}`);
        }
      }),
      mappings,
    );
  }

  get targetFields(): string[] {
    return this.mappings.map((mapping) => mapping.to);
  }

  /** Source fields worth fetching, or undefined when an expression may read any field of the row. */
  get sourceFields(): string[] | undefined {
    return sourceFieldsOf(this.specs);
  }

  map(row: Row): Row {
    const target: Row = {};
    for (const mapping of this.mappings) {
      const value = mapping.from === undefined ? undefined : getPath(row, mapping.from);
      try {
        const result = mapping.apply(value, row);
        target[mapping.to] = result === undefined ? null : result;
      } catch (error) {
        throw new RowMappingError(mapping.to, error);
      }
    }
    return target;
  }
}

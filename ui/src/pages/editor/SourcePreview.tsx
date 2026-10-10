import type { Row, SourcePreview } from '../../api/types';
import { ErrorNotice, Hint } from '../../components/Feedback';
import { formatValue } from '../../lib/format';

/** Source rows as the database returns them, before any mapping. */
export function SourceRowsTable({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return <Hint>No source rows match. Check the table and the conditions.</Hint>;
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return (
    <div className="preview">
      <p className="preview-caption">
        First {rows.length} source rows with the conditions applied, every field and lookups attached, nothing mapped.
      </p>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {columns.map((column) => (
                  <td key={column} className={row[column] === null || row[column] === undefined ? 'is-null' : undefined}>
                    {formatValue(row[column])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The queries a run sends, in order: the source read, each lookup once per batch, then the write. */
export function StatementView({ preview, incremental, write }: {
  preview: SourcePreview;
  incremental: boolean;
  /** From the mapped preview: undefined statement means it has not run (or failed with `error`). */
  write: { target: string; statement?: string | null; error?: unknown };
}) {
  const writeStep = preview.lookups.length + 2;
  return (
    <div className="preview statements">
      <p className="preview-caption">
        The queries a run sends, exactly as the connectors build them. Values are written in so you can copy and run a query;
        Syncforge itself sends them as bound parameters.
        {preview.lookups.length > 0 &&
          ' Lookups are separate queries, not SQL joins, so they work across databases: one query per lookup for each batch of source rows.'}
      </p>
      <h3 className="statement-title">1. Read the source{incremental && ' (first run; later runs add “watermark ≥ last value seen”)'}</h3>
      <pre className="statement">{preview.statement}</pre>
      {preview.lookups.map((lookup, index) => (
        <div key={lookup.as} className="statement-step">
          <h3 className="statement-title">
            {index + 2}. Look up <code>{lookup.as}</code> in {lookup.connection} / {lookup.collection}
          </h3>
          {lookup.statement ? (
            <>
              <pre className="statement">{lookup.statement}</pre>
              <p className="field-hint">
                Shown with the first keys of the preview rows ({lookup.keyCount} looked up). A run sends up to 200 keys per query.
              </p>
            </>
          ) : (
            <p className="field-hint">The preview rows have no keys for this lookup, so it sent no query.</p>
          )}
        </div>
      ))}
      <div className="statement-step">
        <h3 className="statement-title">
          {writeStep}. Write to {write.target}
        </h3>
        {write.statement ? (
          <>
            <pre className="statement statement-write">{write.statement}</pre>
            <p className="field-hint">Shown for the first mapped preview rows. A run writes each batch the same way.</p>
          </>
        ) : write.error ? (
          <ErrorNotice error={write.error} />
        ) : write.statement === null ? (
          <p className="field-hint">No preview row could be mapped, so there is nothing to write.</p>
        ) : (
          <p className="field-hint">Use “Preview 10 rows” to see the write query. It needs a target and mappings.</p>
        )}
      </div>
    </div>
  );
}

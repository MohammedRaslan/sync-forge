import type { PreviewResult } from '../../api/types';
import { Hint } from '../../components/Feedback';
import { formatValue } from '../../lib/format';

export function PreviewTable({ preview }: { preview: PreviewResult }) {
  if (preview.rows.length === 0) return <Hint>The source returned no rows.</Hint>;
  const failed = preview.rows.filter((row) => row.error).length;

  return (
    <div className="preview">
      <p className="preview-caption">
        First {preview.rows.length} source rows as they would be written. Nothing was written.
        {failed > 0 && ` ${failed} row${failed === 1 ? '' : 's'} failed to map.`}
      </p>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              {preview.fields.map((field) => (
                <th key={field} scope="col">
                  {field}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, index) =>
              row.error ? (
                <tr key={index} className="row-error">
                  <td colSpan={preview.fields.length}>
                    {row.error}
                    <code className="row-source">{JSON.stringify(row.source)}</code>
                  </td>
                </tr>
              ) : (
                <tr key={index}>
                  {preview.fields.map((field) => (
                    <td key={field} className={row.target?.[field] === null ? 'is-null' : undefined}>
                      {formatValue(row.target?.[field])}
                    </td>
                  ))}
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

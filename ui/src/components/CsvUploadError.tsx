import { CsvUploadRefused } from '../lib/csvUpload';

/** The message for a failed upload; a file over the limit links to Settings, where the limit is changed. */
export function CsvUploadError({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof CsvUploadRefused && error.reason === 'size') {
    return (
      <span className="upload-error">
        {message} (change the limit in <a href="#/settings">Settings</a>).
      </span>
    );
  }
  return <span className="upload-error">{message}</span>;
}

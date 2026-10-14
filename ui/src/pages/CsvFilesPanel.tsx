import { ChangeEvent, DragEvent, useRef, useState } from 'react';
import { api } from '../api/client';
import type { CsvFileInfo } from '../api/types';
import { CsvUploadError } from '../components/CsvUploadError';
import { ErrorNotice, Hint, Loading } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { useAsync } from '../hooks/useAsync';
import { maxUploadMb, uploadCsvFile } from '../lib/csvUpload';
import { formatBytes, formatRelative } from '../lib/format';

/** An upload in progress, or one that failed and stays listed until dismissed. */
interface Upload {
  id: number;
  name: string;
  progress: number;
  error?: unknown;
}

/** The files of a CSV connection: drop or choose files to upload, replace or delete the ones already there. */
export function CsvFilesPanel({ connectionId }: { connectionId: string }) {
  const files = useAsync(() => api.connections.files(connectionId), [connectionId]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
  const nextUploadId = useRef(0);
  const addPicker = useRef<HTMLInputElement>(null);
  const replacePicker = useRef<HTMLInputElement>(null);
  // The file a Replace click is for; read when the picker reports the chosen file.
  const replaceTarget = useRef<string>();

  const maxBytes = files.data?.maxBytes;

  const upload = async (file: File, name: string, limit: number) => {
    const id = ++nextUploadId.current;
    const patch = (changes: Partial<Upload>) =>
      setUploads((previous) => previous.map((item) => (item.id === id ? { ...item, ...changes } : item)));
    setUploads((previous) => [...previous, { id, name, progress: 0 }]);
    try {
      await uploadCsvFile(connectionId, file, name, limit, (progress) => patch({ progress }));
      setUploads((previous) => previous.filter((item) => item.id !== id));
      await files.reload();
    } catch (error) {
      patch({ error });
    }
  };

  const uploadAll = (chosen: FileList | null) => {
    if (!chosen || maxBytes === undefined) return;
    for (const file of Array.from(chosen)) void upload(file, file.name, maxBytes);
  };

  const pickedToAdd = (event: ChangeEvent<HTMLInputElement>) => {
    uploadAll(event.target.files);
    // Cleared so picking the same file again still fires a change.
    event.target.value = '';
  };

  const pickedToReplace = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const name = replaceTarget.current;
    if (file && name && maxBytes !== undefined) void upload(file, name, maxBytes);
    event.target.value = '';
  };

  const replace = (name: string) => {
    replaceTarget.current = name;
    replacePicker.current?.click();
  };

  const remove = async (file: CsvFileInfo) => {
    const confirmed = window.confirm(`Delete “${file.name}”? Jobs that read it will fail until you upload it again.`);
    if (!confirmed) return;
    setActionError(undefined);
    try {
      await api.connections.removeFile(connectionId, file.name);
      await files.reload();
    } catch (error) {
      setActionError(error);
    }
  };

  const dragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(true);
  };

  // Leaving for a child element is not leaving the zone.
  const dragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
  };

  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    uploadAll(event.dataTransfer.files);
  };

  const dismiss = (id: number) => setUploads((previous) => previous.filter((item) => item.id !== id));

  return (
    <section className="csv-files" aria-label="Files">
      <ErrorNotice error={files.error ?? actionError} />
      {files.loading && !files.data && <Loading label="Loading files" />}

      {maxBytes !== undefined && (
        <div
          className={`dropzone${dragging ? ' is-over' : ''}`}
          onDragOver={dragOver}
          onDragLeave={dragLeave}
          onDrop={drop}
        >
          <span>Drop CSV files here or</span>
          <button type="button" className="btn" onClick={() => addPicker.current?.click()}>
            <Icon name="upload" /> Choose files
          </button>
          <span>· up to {maxUploadMb(maxBytes)} MB</span>
        </div>
      )}
      <input ref={addPicker} type="file" accept=".csv,text/csv" multiple hidden onChange={pickedToAdd} />
      <input ref={replacePicker} type="file" accept=".csv,text/csv" hidden onChange={pickedToReplace} />

      {uploads.length > 0 && (
        <ul className="upload-list">
          {uploads.map((item) => (
            <li key={item.id} className="upload-row">
              <code className="upload-name">{item.name}</code>
              {item.error ? (
                <>
                  <button type="button" className="icon-button" onClick={() => dismiss(item.id)} aria-label={`Dismiss ${item.name}`} title="Dismiss">
                    <Icon name="x" />
                  </button>
                  <p className="upload-message" role="alert">
                    <CsvUploadError error={item.error} />
                  </p>
                </>
              ) : (
                <>
                  <span className="upload-percent">{Math.round(item.progress * 100)}%</span>
                  <div
                    className="upload-bar"
                    role="progressbar"
                    aria-label={`Uploading ${item.name}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(item.progress * 100)}
                  >
                    <span style={{ width: `${item.progress * 100}%` }} />
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {files.data?.files.length === 0 && <Hint>No files yet. Upload a CSV file to read it in a job.</Hint>}
      {files.data && files.data.files.length > 0 && (
        <div className="field-list">
          <div className="field-list-head">
            <span>{files.data.files.length === 1 ? '1 file' : `${files.data.files.length} files`}</span>
          </div>
          <ul className="csv-file-rows">
            {files.data.files.map((file) => (
              <li key={file.name} className="csv-file-row">
                <code className="csv-file-name">{file.name}</code>
                <span className="csv-file-meta">
                  {formatBytes(file.size)} · {formatRelative(file.modifiedAt)}
                </span>
                <span className="csv-file-actions">
                  <button type="button" className="icon-button" onClick={() => replace(file.name)} aria-label={`Replace ${file.name}`} title="Replace">
                    <Icon name="upload" />
                  </button>
                  <button
                    type="button"
                    className="icon-button icon-button-danger"
                    onClick={() => remove(file)}
                    aria-label={`Delete ${file.name}`}
                    title="Delete"
                  >
                    <Icon name="trash" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

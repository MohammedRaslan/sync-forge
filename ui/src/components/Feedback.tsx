import type { ReactNode } from 'react';
import type { ApiIssue } from '../api/client';
import { ApiError } from '../api/client';
import type { RunStatus } from '../api/types';

export function ErrorNotice({ error, title }: { error: unknown; title?: string }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const issues: ApiIssue[] = error instanceof ApiError ? error.issues : [];
  return (
    <div className="notice notice-error" role="alert">
      {title && <strong>{title}</strong>}
      <p>{message}</p>
      {issues.length > 1 && (
        <ul>
          {issues.map((issue) => (
            <li key={`${issue.path}-${issue.message}`}>
              {issue.path && <code>{issue.path}</code>} {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Hint({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  return <p className={`hint hint-${tone}`}>{children}</p>;
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <p className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </p>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

const STATUS_LABEL: Record<RunStatus, string> = {
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function StatusPill({ status }: { status: RunStatus | 'never' }) {
  return <span className={`pill pill-${status}`}>{status === 'never' ? 'Never run' : STATUS_LABEL[status]}</span>;
}

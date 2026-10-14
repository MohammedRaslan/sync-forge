import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Connection, Job, ReconcileSummary, RunSummary } from '../api/types';
import { Conduit } from '../components/Conduit';
import { EmptyState, ErrorNotice, Loading, StatusPill } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { useAsync } from '../hooks/useAsync';
import { useInterval } from '../hooks/useInterval';
import { formatCount, formatRelative } from '../lib/format';

type JobFilter = 'all' | 'attention';

/** A job needs attention when its latest run failed or skipped rows, or its latest check found differences. */
function needsAttention(run: RunSummary | undefined, reconcile: ReconcileSummary | undefined): boolean {
  if (run && (run.status === 'failed' || run.stats.skipped > 0)) return true;
  return Boolean(reconcile && !isInSync(reconcile));
}

function isInSync(reconcile: ReconcileSummary): boolean {
  return reconcile.missingCount === 0 && reconcile.mismatchedRows === 0 && reconcile.sourceCount === reconcile.targetCount;
}

/** Case-insensitive match of a search term against a job's name, tables, query and connection names. */
function matchesSearch(job: Job, connections: ReadonlyMap<string, Connection>, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    job.name,
    job.source.collection,
    job.target.collection,
    job.source.query,
    connections.get(job.source.connectionId)?.name,
    connections.get(job.target.connectionId)?.name,
  ];
  return haystack.some((value) => value?.toLowerCase().includes(needle));
}

/** "Checked 5 min ago: in sync", or what the latest check found to differ. */
function reconcileText(reconcile: ReconcileSummary): string {
  const checked = `Checked ${formatRelative(reconcile.checkedAt)}`;
  if (isInSync(reconcile)) return `${checked}: in sync`;
  const parts = [
    reconcile.missingCount > 0 && `${formatCount(reconcile.missingCount)} missing`,
    reconcile.mismatchedRows > 0 && `${formatCount(reconcile.mismatchedRows)} differ`,
  ].filter(Boolean);
  if (parts.length > 0) return `${checked}: ${parts.join(', ')}`;
  return `${checked}: source ${formatCount(reconcile.sourceCount)} / target ${formatCount(reconcile.targetCount)} rows`;
}

export function JobsPage() {
  const overview = useAsync(async () => {
    const [jobs, connections, latest, reconciles] = await Promise.all([
      api.jobs.list(),
      api.connections.list(),
      api.runs.latest(),
      api.reconciles.latest(),
    ]);
    return { jobs, connections: new Map(connections.map((c) => [c.id, c])), latest, reconciles, hasConnections: connections.length > 0 };
  }, []);

  const data = overview.data;
  const anyRunning = Boolean(data && Object.values(data.latest).some((run) => run.status === 'running'));
  useInterval(() => void overview.reload(), 2000, anyRunning);
  const [actionError, setActionError] = useState<unknown>();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<JobFilter>('all');

  const attentionJobs = data ? data.jobs.filter((job) => needsAttention(data.latest[job.id], data.reconciles[job.id])) : [];
  const shownJobs = data
    ? (filter === 'attention' ? attentionJobs : data.jobs).filter((job) => matchesSearch(job, data.connections, search))
    : [];
  const filterLabels: Record<JobFilter, string> = {
    all: `All (${data?.jobs.length ?? 0})`,
    attention: `Needs attention (${attentionJobs.length})`,
  };

  const clearFilters = () => {
    setSearch('');
    setFilter('all');
  };

  const remove = async (job: Job) => {
    const confirmed = window.confirm(`Delete “${job.name}”? Its run history is kept, the data it wrote is not touched.`);
    if (!confirmed) return;
    setActionError(undefined);
    try {
      await api.jobs.remove(job.id);
      await overview.reload();
    } catch (error) {
      setActionError(error);
    }
  };

  return (
    <>
      <PageHeader
        title="Sync jobs"
        description="Each job copies data from one source collection to one target, with field mappings you control."
        actions={
          data?.hasConnections && (
            <Link to="/jobs/new" className="btn btn-primary">
              <Icon name="plus" /> New job
            </Link>
          )
        }
      />

      <ErrorNotice error={overview.error ?? actionError} />
      {overview.loading && !data && <Loading />}

      {data && data.jobs.length === 0 && (
        data.hasConnections ? (
          <EmptyState title="No jobs yet" action={<Link to="/jobs/new" className="btn btn-primary"><Icon name="plus" /> Create a job</Link>}>
            Pick a source table, choose the fields you need, and point them at a target.
          </EmptyState>
        ) : (
          <EmptyState title="Start with a connection" action={<Link to="/connections" className="btn btn-primary"><Icon name="database" /> Add a connection</Link>}>
            Jobs read from and write to saved connections. Add at least one database first.
          </EmptyState>
        )
      )}

      {data && data.jobs.length > 0 && (
        <div className="job-toolbar">
          <input
            type="search"
            className="job-search"
            placeholder="Search jobs, tables or connections"
            aria-label="Search jobs"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <fieldset className="segmented" aria-label="Show jobs">
            {(['all', 'attention'] as const).map((option) => (
              <label key={option} className={filter === option ? 'is-selected' : undefined}>
                <input type="radio" name="job-filter" checked={filter === option} onChange={() => setFilter(option)} />
                {filterLabels[option]}
              </label>
            ))}
          </fieldset>
        </div>
      )}

      {data && data.jobs.length > 0 && shownJobs.length === 0 && (
        <EmptyState title="No jobs match" action={<button type="button" className="link-button" onClick={clearFilters}>Clear filters</button>} />
      )}

      <ul className="job-list">
        {shownJobs.map((job) => {
          const run = data?.latest[job.id];
          const reconcile = data?.reconciles[job.id];
          const source = data?.connections.get(job.source.connectionId);
          const target = data?.connections.get(job.target.connectionId);
          return (
            <li key={job.id} className="job-item">
              <Link to={`/jobs/${job.id}`} className="job-row">
                <div className="job-row-head">
                  <h2>{job.name}</h2>
                  <StatusPill status={run?.status ?? 'never'} />
                </div>
                <Conduit
                  compact
                  active={run?.status === 'running'}
                  source={{ collection: job.source.collection, kind: source?.kind }}
                  target={{ collection: job.target.collection, kind: target?.kind }}
                />
                <ul className="job-row-health">
                  <li>{job.mode === 'incremental' ? `Incremental on ${job.watermarkField}` : 'Full copy'}</li>
                  {run && (
                    <li>
                      Last run {formatRelative(run.startedAt)}, {formatCount(run.stats.written)} rows written
                    </li>
                  )}
                  {run && run.stats.skipped > 0 && <li className="is-warn">{formatCount(run.stats.skipped)} rows skipped</li>}
                  {run?.status === 'failed' && run.error && (
                    <li className="is-danger job-row-error" title={run.error}>
                      {run.error.split('\n')[0]}
                    </li>
                  )}
                  {reconcile && (
                    <li className={isInSync(reconcile) ? 'is-ok' : 'is-warn'}>{reconcileText(reconcile)}</li>
                  )}
                </ul>
              </Link>
              {/* Siblings of the card link, not inside it: links and buttons cannot nest in a link. */}
              <div className="job-row-actions">
                <Link
                  to={`/jobs/new?from=${encodeURIComponent(job.id)}`}
                  className="icon-button"
                  aria-label={`Duplicate ${job.name}`}
                  title="Duplicate: open the editor with a copy of this job"
                >
                  <Icon name="copy" />
                </Link>
                <button
                  type="button"
                  className="icon-button icon-button-danger"
                  onClick={() => remove(job)}
                  disabled={run?.status === 'running'}
                  aria-label={`Delete ${job.name}`}
                  title={run?.status === 'running' ? 'This job is running. Cancel the run first.' : 'Delete this job'}
                >
                  <Icon name="trash" />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

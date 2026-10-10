import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { Conduit } from '../components/Conduit';
import { EmptyState, ErrorNotice, Loading, StatusPill } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { useAsync } from '../hooks/useAsync';
import { useInterval } from '../hooks/useInterval';
import { formatCount, formatRelative } from '../lib/format';

export function JobsPage() {
  const overview = useAsync(async () => {
    const [jobs, connections, latest] = await Promise.all([api.jobs.list(), api.connections.list(), api.runs.latest()]);
    return { jobs, connections: new Map(connections.map((c) => [c.id, c])), latest, hasConnections: connections.length > 0 };
  }, []);

  const data = overview.data;
  const anyRunning = Boolean(data && Object.values(data.latest).some((run) => run.status === 'running'));
  useInterval(() => void overview.reload(), 2000, anyRunning);

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

      <ErrorNotice error={overview.error} />
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

      <ul className="job-list">
        {data?.jobs.map((job) => {
          const run = data.latest[job.id];
          const source = data.connections.get(job.source.connectionId);
          const target = data.connections.get(job.target.connectionId);
          return (
            <li key={job.id}>
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
                <p className="job-row-meta">
                  {job.mode === 'incremental' ? `Incremental on ${job.watermarkField}` : 'Full copy'}
                  {run && (
                    <>
                      {', '}last run {formatRelative(run.startedAt)}, {formatCount(run.stats.written)} rows written
                    </>
                  )}
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { DryRunReport, ReconcileReport, RowFailure, RunRecord } from '../api/types';
import { Conduit } from '../components/Conduit';
import { ErrorNotice, Hint, Loading, StatusPill } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { useAsync } from '../hooks/useAsync';
import { useInterval } from '../hooks/useInterval';
import { describeFilter } from '../lib/filters';
import { formatCount, formatDateTime, formatDuration, formatRelative, formatValue, formatWatermark } from '../lib/format';
import { downloadText, runLogText } from '../lib/run-log';

export function JobDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [activeRun, setActiveRun] = useState<RunRecord>();
  const [report, setReport] = useState<ReconcileReport>();
  const [busy, setBusy] = useState<'start' | 'dry-run' | 'cancel' | 'reconcile' | 'export' | 'reset' | 'delete'>();
  const [actionError, setActionError] = useState<unknown>();

  const page = useAsync(async () => {
    const [job, connections, runs, { watermark }] = await Promise.all([
      api.jobs.get(id),
      api.connections.list(),
      api.jobs.runs(id),
      api.jobs.watermark(id),
    ]);
    return { job, connections: new Map(connections.map((c) => [c.id, c])), runs, watermark };
  }, [id]);

  // Pick up a run that was already going when the page opened.
  const runningId = page.data?.runs.find((run) => run.status === 'running')?.id;
  useEffect(() => {
    if (runningId && !activeRun) api.runs.get(runningId).then(setActiveRun, setActionError);
  }, [runningId, activeRun]);

  const isRunning = activeRun?.status === 'running';
  useInterval(
    () => {
      if (!activeRun) return;
      api.runs
        .get(activeRun.id)
        .then((latest) => {
          setActiveRun(latest);
          if (latest.status !== 'running') void page.reload();
        })
        // A missed poll is retried on the next tick; a lasting outage shows up on the next action.
        .catch(() => undefined);
    },
    1000,
    isRunning,
  );

  const act = async (kind: NonNullable<typeof busy>, action: () => Promise<void>) => {
    setBusy(kind);
    setActionError(undefined);
    try {
      await action();
    } catch (error) {
      setActionError(error);
    } finally {
      setBusy(undefined);
    }
  };

  if (page.error) return <ErrorNotice error={page.error} />;
  if (!page.data) return <Loading />;
  const { job, connections, runs, watermark } = page.data;
  const source = connections.get(job.source.connectionId);
  const target = connections.get(job.target.connectionId);

  const start = (dryRun: boolean) =>
    act(dryRun ? 'dry-run' : 'start', async () => {
      setActiveRun(await api.jobs.start(job.id, { dryRun }));
      void page.reload();
    });
  const cancel = () => act('cancel', async () => setActiveRun(await api.runs.cancel(activeRun!.id)));
  const reconcile = () => act('reconcile', async () => setReport(await api.jobs.reconcile(job.id)));
  const exportScript = () =>
    act('export', async () => {
      const { fileName, content } = await api.jobs.exportScript(job.id);
      downloadText(fileName, content);
    });
  const resetWatermark = () =>
    window.confirm('The next run will read every row again. Continue?') &&
    act('reset', async () => {
      await api.jobs.resetWatermark(job.id);
      await page.reload();
    });
  const remove = () =>
    window.confirm(`Delete “${job.name}”? Its run history is kept, the data it wrote is not touched.`) &&
    act('delete', async () => {
      await api.jobs.remove(job.id);
      navigate('/');
    });

  return (
    <div className="job-detail">
      <Link to="/" className="back-link">
        Back to jobs
      </Link>
      <header className="job-hero">
        <div className="job-hero-title">
          <h1>{job.name}</h1>
          {job.description && <p className="page-description">{job.description}</p>}
        </div>
        <Conduit
          active={isRunning}
          source={{ collection: job.source.collection, connection: source?.name ?? 'Missing connection', kind: source?.kind }}
          target={{ collection: job.target.collection, connection: target?.name ?? 'Missing connection', kind: target?.kind }}
        />
        <div className="job-actions">
          {isRunning ? (
            <button type="button" className="btn btn-danger" onClick={cancel} disabled={busy === 'cancel'}>
              <Icon name="stop" /> Cancel run
            </button>
          ) : (
            <>
              <button type="button" className="btn btn-primary" onClick={() => start(false)} disabled={busy !== undefined}>
                <Icon name="play" /> Run now
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => start(true)}
                disabled={busy !== undefined}
                title="Reads, maps and compares with the target, writes nothing"
              >
                <Icon name="eye" /> Dry run
              </button>
            </>
          )}
          <button type="button" className="btn" onClick={reconcile} disabled={busy !== undefined}>
            <Icon name="scale" /> {busy === 'reconcile' ? 'Comparing…' : 'Compare source and target'}
          </button>
          <Link to={`/jobs/${job.id}/edit`} className="btn btn-quiet">
            <Icon name="edit" /> Edit
          </Link>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={exportScript}
            disabled={busy !== undefined}
            title="Download a TypeScript file that runs this job with the engine; secrets come from environment variables"
          >
            <Icon name="download" /> Export script
          </button>
          <button type="button" className="btn btn-quiet btn-danger" onClick={remove} disabled={isRunning}>
            <Icon name="trash" /> Delete
          </button>
        </div>
      </header>

      <ErrorNotice error={actionError} />

      <dl className="facts">
        <div>
          <dt>Mode</dt>
          <dd>{job.mode === 'incremental' ? `Incremental on ${job.watermarkField}` : 'Full copy'}</dd>
        </div>
        <div>
          <dt>Matches rows on</dt>
          <dd>
            <code>{job.target.keyFields.join(', ')}</code>
          </dd>
        </div>
        <div>
          <dt>Fields mapped</dt>
          <dd>{job.mappings.length}</dd>
        </div>
        {job.source.filters && job.source.filters.length > 0 && (
          <div>
            <dt>Only rows where</dt>
            <dd>
              <code>{job.source.filters.map(describeFilter).join(' and ')}</code>
            </dd>
          </div>
        )}
        {job.source.query !== undefined && (
          <div>
            <dt>Reads from</dt>
            <dd>SQL query</dd>
          </div>
        )}
        {job.lookups && job.lookups.length > 0 && (
          <div>
            <dt>Looks up</dt>
            <dd>
              <code>{job.lookups.map((lookup) => `${lookup.as} (${lookup.collection})`).join(', ')}</code>
            </dd>
          </div>
        )}
        {job.mode === 'incremental' && (
          <div>
            <dt>Continues from</dt>
            <dd className="fact-with-action">
              {formatWatermark(watermark)}
              {watermark && (
                <button type="button" className="link-button" onClick={resetWatermark} disabled={isRunning || busy !== undefined}>
                  Start over
                </button>
              )}
            </dd>
          </div>
        )}
      </dl>

      {activeRun && <RunPanel run={activeRun} />}
      {report && <ReconcilePanel report={report} />}

      <section className="panel" aria-labelledby="history-title">
        <h2 id="history-title">Run history</h2>
        {runs.length === 0 ? (
          <Hint>No runs yet. Preview the job from the editor, then run it.</Hint>
        ) : (
          <div className="table-scroll">
            <table className="data-table history-table">
              <thead>
                <tr>
                  <th scope="col">Started</th>
                  <th scope="col">Status</th>
                  <th scope="col">Duration</th>
                  <th scope="col" className="num">Read</th>
                  <th scope="col" className="num">Written</th>
                  <th scope="col" className="num">Skipped</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <button type="button" className="link-button" onClick={() => void api.runs.get(run.id).then(setActiveRun)}>
                        {formatDateTime(run.startedAt)}
                      </button>
                    </td>
                    <td>
                      <StatusPill status={run.status} />
                      {run.dryRun && <span className="tag">dry run</span>}
                    </td>
                    <td>{formatDuration(run.startedAt, run.finishedAt)}</td>
                    <td className="num">{formatCount(run.stats.read)}</td>
                    <td className="num" title={run.dryRun ? 'Dry runs write nothing' : undefined}>
                      {run.dryRun ? '—' : formatCount(run.stats.written)}
                    </td>
                    <td className="num">{formatCount(run.stats.skipped)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function RunPanel({ run }: { run: RunRecord }) {
  const kind = run.dryRun ? 'Dry run' : 'Run';
  const counters: Array<[string, number]> = [
    ['Read', run.stats.read],
    [run.dryRun ? 'Would write' : 'Written', run.stats.written],
    ['Skipped', run.stats.skipped],
    ['Batches', run.stats.batches],
  ];
  return (
    <section className={`panel run-panel run-${run.status}`} aria-labelledby="run-title" aria-live="polite">
      <div className="panel-head">
        <h2 id="run-title">{run.status === 'running' ? `${kind} in progress` : `${kind} from ${formatRelative(run.startedAt)}`}</h2>
        <div className="panel-head-actions">
          <StatusPill status={run.status} />
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => downloadText(`${run.jobId}-${run.id}.txt`, runLogText(run))}
            disabled={run.status === 'running'}
          >
            <Icon name="download" /> Download log
          </button>
        </div>
      </div>
      {run.plan && <DryRunPlan plan={run.plan} />}
      <dl className="counters">
        {counters.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{formatCount(value)}</dd>
          </div>
        ))}
      </dl>
      {run.error && <ErrorNotice error={new Error(run.error)} />}
      {run.failures && run.failures.length > 0 && <FailedRows run={run} failures={run.failures} />}
      <ol className="run-log">
        {run.log.map((entry, index) => (
          <li key={index} className={`log-${entry.level}`}>
            <time dateTime={entry.at}>{new Date(entry.at).toLocaleTimeString()}</time>
            <span>{entry.message}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function DryRunPlan({ plan }: { plan: DryRunReport }) {
  return (
    <div className="dry-run-plan">
      <p className="field-hint">
        Nothing was written. Rows were read, mapped and looked up in the target. Database rules such as unique constraints are only
        checked when writing, so a real run can still refuse rows.
      </p>
      <dl className="counters">
        <div>
          <dt>Would insert</dt>
          <dd>{formatCount(plan.inserts)}</dd>
        </div>
        <div>
          <dt>Would update</dt>
          <dd>{formatCount(plan.updates)}</dd>
        </div>
        <div>
          <dt>Unchanged</dt>
          <dd>{formatCount(plan.unchanged)}</dd>
        </div>
      </dl>
      {plan.newKeys.length > 0 && (
        <p className="new-keys">
          New keys{plan.inserts > plan.newKeys.length && ' (first ones)'}: <code>{plan.newKeys.join(', ')}</code>
        </p>
      )}
      {plan.changes.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Field</th>
                <th scope="col">In target now</th>
                <th scope="col">Would become</th>
              </tr>
            </thead>
            <tbody>
              {plan.changes.map((change, index) => (
                <tr key={index}>
                  <td>{change.key}</td>
                  <td>{change.field}</td>
                  <td className="wrap">{formatValue(change.current)}</td>
                  <td className="wrap is-change">{change.removed ? 'removed' : formatValue(change.next)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const STAGE_LABEL: Record<RowFailure['stage'], string> = { lookup: 'Lookup', map: 'Mapping', write: 'Writing' };

function FailedRows({ run, failures }: { run: RunRecord; failures: RowFailure[] }) {
  return (
    <div className="failed-rows">
      <h3>Rows that could not be synced</h3>
      <p className="field-hint">
        Rows that failed to write were retried once at the end of the run. Fix the cause and run the job again: rows already
        written are updated, never duplicated.
        {run.mode === 'incremental' && !run.dryRun && ' These rows are behind the watermark now, so use Start over to read them again.'}
        {run.stats.skipped > failures.length && ` Showing the first ${formatCount(failures.length)} of ${formatCount(run.stats.skipped)}.`}
      </p>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col" className="num">Row</th>
              <th scope="col">Key</th>
              <th scope="col">Step</th>
              <th scope="col">Reason</th>
              <th scope="col">Values</th>
            </tr>
          </thead>
          <tbody>
            {failures.map((failure) => (
              <tr key={`${failure.stage}-${failure.row}`}>
                <td className="num">{formatCount(failure.row)}</td>
                <td>{failure.key ?? '—'}</td>
                <td>{STAGE_LABEL[failure.stage]}</td>
                <td className="is-diff wrap">{failure.reason}</td>
                <td className="wrap failure-values">{failure.values ? formatValue(failure.values) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReconcilePanel({ report }: { report: ReconcileReport }) {
  const healthy = report.missingCount === 0 && report.mismatchedRows === 0 && report.unmappable === 0;
  const countGap = report.targetCount - report.sourceCount;
  return (
    <section className={`panel reconcile ${healthy ? 'is-healthy' : 'has-issues'}`} aria-labelledby="reconcile-title">
      <div className="panel-head">
        <h2 id="reconcile-title">{healthy ? 'Source and target agree' : 'Source and target differ'}</h2>
        <span className="panel-meta">Checked {formatRelative(report.checkedAt)}</span>
      </div>
      <dl className="counters">
        <div>
          <dt>Source rows</dt>
          <dd>{formatCount(report.sourceCount)}</dd>
        </div>
        <div>
          <dt>Target rows</dt>
          <dd>
            {formatCount(report.targetCount)}
            {countGap !== 0 && <small> ({countGap > 0 ? '+' : ''}{formatCount(countGap)})</small>}
          </dd>
        </div>
        <div>
          <dt>Sample matching</dt>
          <dd>
            {formatCount(report.matched)} / {formatCount(report.sampled)}
          </dd>
        </div>
        <div>
          <dt>Missing in target</dt>
          <dd>{formatCount(report.missingCount)}</dd>
        </div>
      </dl>
      <p className="field-hint">
        Every field of the first {report.sampled} source rows was re-mapped and compared with the target. Row counts cover the whole
        collection, so other writers to the target can make them differ.
        {report.unmappable > 0 && ` ${report.unmappable} sampled rows could not be mapped.`}
      </p>
      {report.missingKeys.length > 0 && (
        <p className="missing-keys">
          Missing keys: <code>{report.missingKeys.join(', ')}</code>
        </p>
      )}
      {report.mismatches.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Field</th>
                <th scope="col">Expected</th>
                <th scope="col">In target</th>
              </tr>
            </thead>
            <tbody>
              {report.mismatches.map((mismatch, index) => (
                <tr key={index}>
                  <td>{mismatch.key}</td>
                  <td>{mismatch.field}</td>
                  <td>{formatValue(mismatch.expected)}</td>
                  <td className="is-diff">{formatValue(mismatch.actual)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

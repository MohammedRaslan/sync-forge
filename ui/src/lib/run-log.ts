import type { RunRecord } from '../api/types';
import { formatValue } from './format';

/** A run as plain text: summary, log, rows that were not synced and, for dry runs, the planned changes. */
export function runLogText(run: RunRecord): string {
  const lines = [
    `${run.dryRun ? 'Dry run' : 'Run'} ${run.id} of "${run.jobName}" (${run.mode})`,
    `Status: ${run.status}`,
    `Started: ${run.startedAt}`,
    `Finished: ${run.finishedAt ?? 'still running'}`,
    `Read ${run.stats.read}, written ${run.dryRun ? 0 : run.stats.written}, skipped ${run.stats.skipped}, batches ${run.stats.batches}`,
  ];
  if (run.error) lines.push(`Error: ${run.error}`);

  lines.push('', 'Log', '---');
  for (const entry of run.log) lines.push(`${entry.at} ${entry.level.toUpperCase().padEnd(5)} ${entry.message}`);

  const failures = run.failures ?? [];
  if (failures.length > 0) {
    lines.push('', `Rows that could not be synced (${failures.length}${run.stats.skipped > failures.length ? ` of ${run.stats.skipped}` : ''})`, '---');
    for (const failure of failures) {
      lines.push(`Row ${failure.row}${failure.key ? ` (key ${failure.key})` : ''} [${failure.stage}]: ${failure.reason}`);
      if (failure.values) lines.push(`  values: ${formatValue(failure.values)}`);
    }
  }

  if (run.plan) {
    const { inserts, updates, unchanged, newKeys, changes } = run.plan;
    lines.push('', 'Dry run plan', '---', `Would insert ${inserts}, update ${updates}, leave ${unchanged} unchanged`);
    if (newKeys.length > 0) lines.push(`New keys${inserts > newKeys.length ? ' (first ones)' : ''}: ${newKeys.join(', ')}`);
    for (const change of changes) {
      lines.push(`${change.key} ${change.field}: ${formatValue(change.current)} -> ${change.removed ? '(removed)' : formatValue(change.next)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Saves text as a file through the browser. */
export function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: fileName });
  link.click();
  // Revoking right away can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

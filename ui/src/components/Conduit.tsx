import type { ConnectionKind } from '../api/types';
import { KIND_LABEL } from '../lib/format';

export interface ConduitEnd {
  collection: string;
  connection?: string;
  kind?: ConnectionKind;
}

/**
 * The signature element: a source node and a target node joined by a line.
 * While a run is active, a signal travels along the line.
 */
export function Conduit({ source, target, active = false, compact = false }: {
  source: ConduitEnd;
  target: ConduitEnd;
  active?: boolean;
  compact?: boolean;
}) {
  return (
    <div className={`conduit${compact ? ' conduit-compact' : ''}${active ? ' is-active' : ''}`}>
      <Node role="source" end={source} compact={compact} />
      <div className="conduit-line" aria-hidden="true">
        <span className="conduit-signal" />
      </div>
      <Node role="target" end={target} compact={compact} />
      {active && <span className="visually-hidden">Sync in progress</span>}
    </div>
  );
}

function Node({ role, end, compact }: { role: 'source' | 'target'; end: ConduitEnd; compact: boolean }) {
  return (
    <div className={`conduit-node conduit-${role}`}>
      {!compact && <span className="conduit-role">{role === 'source' ? 'Reads from' : 'Writes to'}</span>}
      <code className="conduit-collection">{end.collection || '—'}</code>
      {!compact && (end.connection || end.kind) && (
        <span className="conduit-meta">
          {end.connection}
          {end.kind && <em> on {KIND_LABEL[end.kind]}</em>}
        </span>
      )}
    </div>
  );
}

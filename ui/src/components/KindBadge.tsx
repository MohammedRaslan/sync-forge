import type { ConnectionKind } from '../api/types';
import { KIND_LABEL } from '../lib/format';

export function KindBadge({ kind }: { kind: ConnectionKind }) {
  return <span className={`kind kind-${kind}`}>{KIND_LABEL[kind]}</span>;
}

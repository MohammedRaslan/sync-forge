import { JsonDirectoryStore } from '../storage/json-directory-store';
import { StoredReconcileSummary } from './reconcile.model';

export class ReconcilesRepository extends JsonDirectoryStore<StoredReconcileSummary> {}

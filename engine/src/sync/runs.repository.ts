import { JsonDirectoryStore } from '../storage/json-directory-store';
import { RunRecord } from './run.model';

export class RunsRepository extends JsonDirectoryStore<RunRecord> {}

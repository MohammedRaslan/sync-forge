import { JsonDirectoryStore } from '../storage/json-directory-store';
import { Job, JobState } from './job.model';

export class JobsRepository extends JsonDirectoryStore<Job> {}

export class JobStateRepository extends JsonDirectoryStore<JobState> {}

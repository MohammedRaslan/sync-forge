import { JsonDirectoryStore } from '../storage/json-directory-store';
import { StoredConnection } from './connection.model';

export class ConnectionsRepository extends JsonDirectoryStore<StoredConnection> {}

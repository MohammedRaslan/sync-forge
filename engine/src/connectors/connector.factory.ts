import { Injectable } from '@nestjs/common';
import { Connector } from './connector.types';
import { ConnectionConfig } from '../connections/connection.model';
import { PostgresConnector } from './postgres/postgres.connector';
import { MongoConnector } from './mongo/mongo.connector';
import { CosmosConnector } from './cosmos/cosmos.connector';

/** The only place that knows which class implements which database. Add new engines here. */
@Injectable()
export class ConnectorFactory {
  create(config: ConnectionConfig): Connector {
    switch (config.kind) {
      case 'postgres':
        return new PostgresConnector(config);
      case 'mongo':
        return new MongoConnector(config);
      case 'cosmos':
        return new CosmosConnector(config);
    }
  }
}

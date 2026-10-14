import { Injectable } from '@nestjs/common';
import { Connector } from './connector.types';
import { ConnectorConfig } from '../connections/connection.model';
import { PostgresConnector } from './postgres/postgres.connector';
import { MongoConnector } from './mongo/mongo.connector';
import { MysqlConnector } from './mysql/mysql.connector';
import { CosmosConnector } from './cosmos/cosmos.connector';
import { CsvConnector } from './csv/csv.connector';

/** The only place that knows which class implements which database. Add new engines here. */
@Injectable()
export class ConnectorFactory {
  create(config: ConnectorConfig): Connector {
    switch (config.kind) {
      case 'postgres':
        return new PostgresConnector(config);
      case 'mysql':
        return new MysqlConnector(config);
      case 'mongo':
        return new MongoConnector(config);
      case 'cosmos':
        return new CosmosConnector(config);
      case 'csv':
        return new CsvConnector(config);
    }
  }
}

import { Injectable } from '@nestjs/common';
import { Connector } from './connector.types';
import { ConnectorConfig } from '../connections/connection.model';
import { PostgresConnector } from './postgres/postgres.connector';
import { MongoConnector } from './mongo/mongo.connector';
import { MysqlConnector } from './mysql/mysql.connector';
import { CosmosConnector } from './cosmos/cosmos.connector';
import { CsvConnector } from './csv/csv.connector';
import { HttpConnector, HttpConnectorConfig } from './http/http.connector';
import { RequestSpacer } from './http/request-spacer';

/** The only place that knows which class implements which database. Add new engines here. */
@Injectable()
export class ConnectorFactory {
  /** One per API origin, kept for the app's life: a job's source, its lookups and other runs share one request budget. */
  private readonly spacers = new Map<string, RequestSpacer>();

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
      case 'http':
        return this.createHttp(config);
    }
  }

  /** An HTTP API connector as its own type, for what only it offers (a probe, the rate-limit headers of a test). */
  createHttp(config: HttpConnectorConfig): HttpConnector {
    return new HttpConnector(config, { spacer: this.spacerFor(new URL(config.baseUrl).origin) });
  }

  private spacerFor(origin: string): RequestSpacer {
    let spacer = this.spacers.get(origin);
    if (!spacer) {
      spacer = new RequestSpacer();
      this.spacers.set(origin, spacer);
    }
    return spacer;
  }
}

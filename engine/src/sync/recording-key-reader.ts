import { KeyReader, Row } from '../connectors/connector.types';

export interface KeyLookupCall {
  collection: string;
  keyFields: string[];
  keys: Row[];
}

/** Passes key lookups through and remembers the first one, so a preview can show the query a lookup really runs. */
export class RecordingKeyReader implements KeyReader {
  firstCall?: KeyLookupCall;

  constructor(private readonly reader: KeyReader) {}

  findByKeys(collection: string, keyFields: string[], keys: Row[]): Promise<Row[]> {
    this.firstCall ??= { collection, keyFields, keys };
    return this.reader.findByKeys(collection, keyFields, keys);
  }
}

import { IncomingMessage } from 'node:http';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ValidationError } from '../common/errors';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ConnectionsService } from './connections.service';
import { ConnectionInput, connectionConfigSchema, connectionInputSchema } from './connection.model';

const testRequestSchema = z.object({
  config: connectionConfigSchema,
  connectionId: z.string().optional(),
});

const describeQuerySchema = z.object({ query: z.string().trim().min(1, 'Write a query').max(20_000) });

/** Uploads are sent as the raw file. No body parser is registered for text/csv, so the request stream is untouched. */
const CSV_CONTENT_TYPE = 'text/csv';

const collectionQuerySchema = z.string().trim().min(1, 'collection is required');

@Controller('connections')
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  @Get()
  list() {
    return this.connections.list();
  }

  @Post()
  create(@Body(new ZodValidationPipe(connectionInputSchema)) input: ConnectionInput) {
    return this.connections.create(input);
  }

  /** Tests settings before they are saved (used by the connection form). */
  @Post('test')
  @HttpCode(200)
  test(@Body(new ZodValidationPipe(testRequestSchema)) body: z.infer<typeof testRequestSchema>) {
    return this.connections.test(body.config, body.connectionId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.connections.get(id);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body(new ZodValidationPipe(connectionInputSchema)) input: ConnectionInput) {
    return this.connections.update(id, input);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.connections.remove(id);
  }

  @Get(':id/collections')
  collections(@Param('id') id: string) {
    return this.connections.listCollections(id);
  }

  /** The collection is a query parameter because names may contain "/" or ".". */
  @Get(':id/fields')
  fields(@Param('id') id: string, @Query('collection', new ZodValidationPipe(collectionQuerySchema)) collection: string) {
    return this.connections.describeCollection(id, collection);
  }

  /** Columns a custom SQL query returns. POST because queries are long and may contain anything. */
  @Post(':id/query-fields')
  @HttpCode(200)
  queryFields(@Param('id') id: string, @Body(new ZodValidationPipe(describeQuerySchema)) body: z.infer<typeof describeQuerySchema>) {
    return this.connections.describeQuery(id, body.query);
  }

  @Get(':id/files')
  files(@Param('id') id: string) {
    return this.connections.listFiles(id);
  }

  /** Uploads one file as the raw request body, replacing a file of the same name. */
  @Put(':id/files/:name')
  saveFile(@Param('id') id: string, @Param('name') name: string, @Req() request: IncomingMessage) {
    const contentType = request.headers['content-type'] ?? '';
    if (!contentType.toLowerCase().startsWith(CSV_CONTENT_TYPE)) throw new ValidationError('Upload the file as text/csv');
    return this.connections.saveFile(id, name, request, declaredLength(request));
  }

  @Delete(':id/files/:name')
  @HttpCode(204)
  removeFile(@Param('id') id: string, @Param('name') name: string) {
    return this.connections.removeFile(id, name);
  }
}

/** The Content-Length header as a number, or undefined when it is missing (chunked uploads) or not a length. */
function declaredLength(request: IncomingMessage): number | undefined {
  const header = request.headers['content-length'];
  if (header === undefined || !/^\d+$/.test(header)) return undefined;
  return Number(header);
}

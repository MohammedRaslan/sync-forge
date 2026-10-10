import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ConnectionsService } from './connections.service';
import { ConnectionInput, connectionConfigSchema, connectionInputSchema } from './connection.model';

const testRequestSchema = z.object({
  config: connectionConfigSchema,
  connectionId: z.string().optional(),
});

const describeQuerySchema = z.object({ query: z.string().trim().min(1, 'Write a query').max(20_000) });

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
}

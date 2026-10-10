import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { JobInput, jobInputSchema } from './job.model';
import { JobsService } from './jobs.service';

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get()
  list() {
    return this.jobs.list();
  }

  @Post()
  create(@Body(new ZodValidationPipe(jobInputSchema)) input: JobInput) {
    return this.jobs.create(input);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.jobs.get(id);
  }

  /** `{ fileName, content }` of a runnable TypeScript script for the job (no secrets in it). */
  @Get(':id/export')
  exportScript(@Param('id') id: string) {
    return this.jobs.exportScript(id);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body(new ZodValidationPipe(jobInputSchema)) input: JobInput) {
    return this.jobs.update(id, input);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.jobs.remove(id);
  }

  @Get(':id/watermark')
  async watermark(@Param('id') id: string) {
    await this.jobs.get(id);
    return { watermark: await this.jobs.getWatermark(id) };
  }

  @Delete(':id/watermark')
  @HttpCode(204)
  resetWatermark(@Param('id') id: string) {
    return this.jobs.resetWatermark(id);
  }
}

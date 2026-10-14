import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { z } from 'zod';
import { JobInput, SourcePreviewInput, previewInputSchema, sourcePreviewSchema } from '../jobs/job.model';
import { JobsService } from '../jobs/jobs.service';
import { ReconcilesService } from './reconciles.service';
import { RunsService } from './runs.service';
import { SyncService } from './sync.service';

const startRunSchema = z.object({ dryRun: z.boolean().optional() }).default({});

@Controller('jobs')
export class SyncController {
  constructor(
    private readonly jobs: JobsService,
    private readonly runs: RunsService,
    private readonly sync: SyncService,
    private readonly reconciles: ReconcilesService,
  ) {}

  /** Dry run of an unsaved job: reads a few rows and maps them, writes nothing. */
  @Post('preview')
  @HttpCode(200)
  preview(@Body(new ZodValidationPipe(previewInputSchema)) job: JobInput) {
    return this.sync.preview(job);
  }

  /** Raw source rows and the read statement; needs no target or mappings yet. */
  @Post('source-preview')
  @HttpCode(200)
  previewSource(@Body(new ZodValidationPipe(sourcePreviewSchema)) input: SourcePreviewInput) {
    return this.sync.previewSource(input);
  }

  /** Body `{ "dryRun": true }` reads, maps and compares without writing. */
  @Post(':id/runs')
  @HttpCode(202)
  start(@Param('id') id: string, @Body(new ZodValidationPipe(startRunSchema)) body: z.infer<typeof startRunSchema>) {
    return this.runs.start(id, body);
  }

  @Get(':id/runs')
  history(@Param('id') id: string) {
    return this.runs.listForJob(id);
  }

  /** Also stores the report's counts as the job's latest reconcile. */
  @Post(':id/reconcile')
  @HttpCode(200)
  async reconcile(@Param('id') id: string) {
    return this.reconciles.reconcile(await this.jobs.get(id));
  }
}

@Controller('runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get('latest')
  latest() {
    return this.runs.latestByJob();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.runs.get(id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string) {
    return this.runs.cancel(id);
  }
}

@Controller('reconciles')
export class ReconcilesController {
  constructor(private readonly reconciles: ReconcilesService) {}

  /** Counts of the latest reconcile per job id. */
  @Get('latest')
  latest() {
    return this.reconciles.latestByJob();
  }
}

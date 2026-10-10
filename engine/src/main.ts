import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AppExceptionFilter } from './common/app-exception.filter';
import { APP_CONFIG, AppConfig } from './config/app-config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get<AppConfig>(APP_CONFIG);
  const logger = new Logger('Syncforge');

  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AppExceptionFilter());
  app.useBodyParser('json', { limit: '1mb' });
  app.enableCors({ origin: config.corsOrigin });
  app.enableShutdownHooks();

  // The UI uses hash routing, so serving the static build is all it needs.
  if (config.uiDir && existsSync(config.uiDir)) app.useStaticAssets(config.uiDir);

  await app.listen(config.port, config.host);
  logger.log(`Listening on http://${config.host}:${config.port} (workspace: ${config.workspaceDir})`);
}

void bootstrap();

import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig, loadConfig } from './config/app-config';
import { ConnectorFactory } from './connectors/connector.factory';
import { SecretBox } from './storage/secret-box';
import { Workspace } from './storage/workspace';
import { TransformRegistry } from './transforms/transform.registry';

/** Process-wide singletons shared by every feature module. */
@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    {
      provide: Workspace,
      useFactory: async (config: AppConfig) => {
        const workspace = new Workspace(config.workspaceDir);
        await workspace.prepare();
        return workspace;
      },
      inject: [APP_CONFIG],
    },
    {
      provide: SecretBox,
      useFactory: (config: AppConfig, workspace: Workspace) => SecretBox.load(workspace.local('secret.key'), config.secretKey),
      inject: [APP_CONFIG, Workspace],
    },
    TransformRegistry,
    ConnectorFactory,
  ],
  exports: [APP_CONFIG, Workspace, SecretBox, TransformRegistry, ConnectorFactory],
})
export class CoreModule {}

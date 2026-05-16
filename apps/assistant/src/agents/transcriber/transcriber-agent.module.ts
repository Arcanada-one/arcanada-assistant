import { Logger, Module, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';

import { TRANSCRIBER_CONFIG, type TranscriberConfig } from '../../config/transcriber.config.js';
import { AgentRegistry } from '../../orchestrator/agent.registry.js';
import { OrchestratorModule } from '../../orchestrator/orchestrator.module.js';

import { TranscriberClient, type ITranscriberClient, type TranscriberLogger } from './transcriber.client.js';
import { TRANSCRIBER_CLIENT, TranscriberAgentService } from './transcriber-agent.service.js';

function adaptLogger(pino: PinoLogger): TranscriberLogger {
  return {
    info: (obj, msg) => pino.info(obj, msg ?? ''),
    warn: (obj, msg) => pino.warn(obj, msg ?? ''),
    error: (obj, msg) => pino.error(obj, msg ?? ''),
    debug: (obj, msg) => pino.debug(obj, msg ?? ''),
  };
}

@Module({
  imports: [OrchestratorModule],
  providers: [
    TranscriberAgentService,
    {
      provide: TRANSCRIBER_CLIENT,
      inject: [ConfigService, PinoLogger],
      useFactory: (config: ConfigService, pino: PinoLogger): ITranscriberClient => {
        const ns = config.getOrThrow<TranscriberConfig>(TRANSCRIBER_CONFIG);
        return new TranscriberClient({
          baseUrl: ns.baseUrl,
          apiKey: ns.apiKey,
          logger: adaptLogger(pino),
          timeoutMs: ns.timeoutMs,
          ...(ns.defaultModel ? { defaultModel: ns.defaultModel } : {}),
          serviceName: 'arcanada-assistant',
        });
      },
    },
  ],
  exports: [TRANSCRIBER_CLIENT, TranscriberAgentService],
})
export class TranscriberAgentModule implements OnModuleInit {
  private readonly logger = new Logger(TranscriberAgentModule.name);

  constructor(
    private readonly registry: AgentRegistry,
    private readonly agent: TranscriberAgentService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const ns = this.config.getOrThrow<TranscriberConfig>(TRANSCRIBER_CONFIG);
    if (!ns.integrationEnabled) {
      this.logger.warn(
        'ECOSYSTEM_TRANSCRIBER_INTEGRATION=false — TranscriberAgent not registered',
      );
      return;
    }
    this.registry.register(this.agent);
  }
}

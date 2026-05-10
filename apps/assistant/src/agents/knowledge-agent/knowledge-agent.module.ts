import { Logger, Module, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScrutatorClient, type IScrutatorClient, type ScrutatorLogger } from '@arcanada/core';
import { PinoLogger } from 'nestjs-pino';

import { SCRUTATOR_CONFIG, type ScrutatorConfig } from '../../config/scrutator.config.js';
import { AgentRegistry } from '../../orchestrator/agent.registry.js';
import { OrchestratorModule } from '../../orchestrator/orchestrator.module.js';
import { DialogContextService } from '../../orchestrator/dialog.context.js';

import {
  KnowledgeAgentService,
  SCRUTATOR_CLIENT,
  SCRUTATOR_LTM_NAMESPACE,
} from './knowledge-agent.service.js';

function adaptLogger(pino: PinoLogger): ScrutatorLogger {
  return {
    info: (obj, msg) => pino.info(obj, msg ?? ''),
    warn: (obj, msg) => pino.warn(obj, msg ?? ''),
    error: (obj, msg) => pino.error(obj, msg ?? ''),
    debug: (obj, msg) => pino.debug(obj, msg ?? ''),
  };
}

@Module({
  // scrutatorConfig namespace зарегистрирован globally в AppModule.forRoot.load
  // (isGlobal: true), forFeature избыточен.
  imports: [OrchestratorModule],
  providers: [
    KnowledgeAgentService,
    DialogContextService,
    {
      provide: SCRUTATOR_CLIENT,
      inject: [ConfigService, PinoLogger],
      useFactory: (config: ConfigService, pino: PinoLogger): IScrutatorClient => {
        const ns = config.getOrThrow<ScrutatorConfig>(SCRUTATOR_CONFIG);
        return new ScrutatorClient({
          baseUrl: ns.baseUrl,
          logger: adaptLogger(pino),
          serviceName: 'arcanada-assistant',
        });
      },
    },
    {
      provide: SCRUTATOR_LTM_NAMESPACE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): string => {
        const ns = config.getOrThrow<ScrutatorConfig>(SCRUTATOR_CONFIG);
        return ns.ltmNamespace;
      },
    },
  ],
  exports: [SCRUTATOR_CLIENT, KnowledgeAgentService, DialogContextService],
})
export class KnowledgeAgentModule implements OnModuleInit {
  private readonly logger = new Logger(KnowledgeAgentModule.name);

  constructor(
    private readonly registry: AgentRegistry,
    private readonly agent: KnowledgeAgentService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const enabled = this.config.get<boolean>('ECOSYSTEM_SCRUTATOR_INTEGRATION') ?? true;
    if (!enabled) {
      this.logger.warn('ECOSYSTEM_SCRUTATOR_INTEGRATION=false — KnowledgeAgent not registered');
      return;
    }
    this.registry.register(this.agent);
  }
}

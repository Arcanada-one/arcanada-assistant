import { Logger, Module, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ScrutatorClient,
  type IOpsBotClient,
  type IScrutatorClient,
  type ScrutatorLogger,
  type ScrutatorSelfHealPayload,
} from '@arcanada/core';
import { PinoLogger } from 'nestjs-pino';

import { SCRUTATOR_CONFIG, type ScrutatorConfig } from '../../config/scrutator.config.js';
import { AgentRegistry } from '../../orchestrator/agent.registry.js';
import { OrchestratorModule } from '../../orchestrator/orchestrator.module.js';
import { DialogContextService } from '../../orchestrator/dialog.context.js';
import { OpsAgentModule } from '../ops-agent/ops-agent.module.js';
import { OPS_BOT_CLIENT } from '../ops-agent/ops-agent.service.js';

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
  // (isGlobal: true), forFeature избыточен. OpsAgentModule import — для
  // ARCA-0102: self-heal recovery emit идёт через OpsBotClient.emitEvent.
  imports: [OrchestratorModule, OpsAgentModule],
  providers: [
    KnowledgeAgentService,
    DialogContextService,
    {
      provide: SCRUTATOR_CLIENT,
      inject: [ConfigService, PinoLogger, OPS_BOT_CLIENT],
      useFactory: (
        config: ConfigService,
        pino: PinoLogger,
        opsBot: IOpsBotClient,
      ): IScrutatorClient => {
        const ns = config.getOrThrow<ScrutatorConfig>(SCRUTATOR_CONFIG);
        const log = adaptLogger(pino);
        return new ScrutatorClient({
          baseUrl: ns.baseUrl,
          logger: log,
          serviceName: 'arcanada-assistant',
          selfHealEmit: (payload: ScrutatorSelfHealPayload) =>
            opsBot
              .emitEvent({
                service: 'arcanada-assistant',
                category: 'self_heal',
                severity: 'info',
                message: 'scrutator client circuit breaker recovered (close)',
                context: {
                  component: payload.component,
                  level_attempted: payload.level_attempted,
                  fix_applied: payload.fix_applied,
                  outcome: payload.outcome,
                  state: payload.state,
                },
              })
              .then(() => undefined)
              .catch((err) =>
                log.warn(
                  { err: err instanceof Error ? err.message : String(err) },
                  'scrutator self_heal emit to ops-bot failed (non-fatal)',
                ),
              ),
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

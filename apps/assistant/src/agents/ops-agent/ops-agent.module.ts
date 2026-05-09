import { Logger, Module, type OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { OpsBotClient, type IOpsBotClient, type OpsBotLogger } from '@arcanada/core';
import { PinoLogger } from 'nestjs-pino';

import opsBotConfig, { OPS_BOT_CONFIG, type OpsBotConfig } from '../../config/ops-bot.config.js';
import { DatabaseModule } from '../../database/database.module.js';
import { RedisService } from '../../database/redis.service.js';
import { AgentRegistry } from '../../orchestrator/agent.registry.js';
import { OrchestratorModule } from '../../orchestrator/orchestrator.module.js';

import { OPS_BOT_CLIENT, OpsAgentService } from './ops-agent.service.js';

function adaptLogger(pino: PinoLogger): OpsBotLogger {
  return {
    info: (obj, msg) => pino.info(obj, msg ?? ''),
    warn: (obj, msg) => pino.warn(obj, msg ?? ''),
    error: (obj, msg) => pino.error(obj, msg ?? ''),
    debug: (obj, msg) => pino.debug(obj, msg ?? ''),
  };
}

@Module({
  imports: [DatabaseModule, OrchestratorModule, ConfigModule.forFeature(opsBotConfig)],
  providers: [
    OpsAgentService,
    {
      provide: OPS_BOT_CLIENT,
      inject: [ConfigService, RedisService, PinoLogger],
      useFactory: (
        config: ConfigService,
        redisService: RedisService,
        pino: PinoLogger,
      ): IOpsBotClient => {
        const ns = config.getOrThrow<OpsBotConfig>(OPS_BOT_CONFIG);
        return new OpsBotClient({
          baseUrl: ns.baseUrl,
          apiKey: ns.apiKey,
          redis: redisService.client,
          logger: adaptLogger(pino),
        });
      },
    },
  ],
  exports: [OPS_BOT_CLIENT, OpsAgentService],
})
export class OpsAgentModule implements OnModuleInit {
  private readonly logger = new Logger(OpsAgentModule.name);

  constructor(
    private readonly registry: AgentRegistry,
    private readonly agent: OpsAgentService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const enabled = this.config.get<boolean>('ECOSYSTEM_OPS_BOT_INTEGRATION') ?? true;
    if (!enabled) {
      this.logger.warn('ECOSYSTEM_OPS_BOT_INTEGRATION=false — OpsAgent not registered');
      return;
    }
    this.registry.register(this.agent);
  }
}

import { Logger, Module, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';

import { DREAMER_CONFIG, type DreamerConfig } from '../../config/dreamer.config.js';
import { AgentRegistry } from '../../orchestrator/agent.registry.js';
import { OrchestratorModule } from '../../orchestrator/orchestrator.module.js';

import { DreamerClient, type DreamerLogger, type IDreamerClient } from './dreamer.client.js';
import { DREAMER_CLIENT, DreamerAgentService } from './dreamer-agent.service.js';

function adaptLogger(pino: PinoLogger): DreamerLogger {
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
    DreamerAgentService,
    {
      provide: DREAMER_CLIENT,
      inject: [ConfigService, PinoLogger],
      useFactory: (config: ConfigService, pino: PinoLogger): IDreamerClient => {
        const ns = config.getOrThrow<DreamerConfig>(DREAMER_CONFIG);
        return new DreamerClient({
          ...(ns.baseUrl ? { baseUrl: ns.baseUrl } : {}),
          ...(ns.apiToken ? { apiToken: ns.apiToken } : {}),
          timeoutMs: ns.timeoutMs,
          live: ns.live,
          logger: adaptLogger(pino),
        });
      },
    },
  ],
  exports: [DREAMER_CLIENT, DreamerAgentService],
})
export class DreamerAgentModule implements OnModuleInit {
  private readonly logger = new Logger(DreamerAgentModule.name);

  constructor(
    private readonly registry: AgentRegistry,
    private readonly agent: DreamerAgentService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const ns = this.config.getOrThrow<DreamerConfig>(DREAMER_CONFIG);
    if (ns.live) {
      this.registry.register(this.agent);
      this.logger.warn(
        'ECOSYSTEM_DREAMER_LIVE=true requested but live HTTP path is unimplemented — skeleton fallback active until ARCA-* Phase 6b ships',
      );
    } else {
      this.logger.warn(
        'ECOSYSTEM_DREAMER_LIVE=false — DreamerAgent NOT registered in mesh registry (skeleton mode); flip env var to true after AGENT-0062 lands',
      );
    }
  }
}

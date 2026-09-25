import { Logger, Module, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';

import { MUNERA_CONFIG, type MuneraConfig } from '../../config/munera.config.js';
import { AgentRegistry } from '../../orchestrator/agent.registry.js';
import { OrchestratorModule } from '../../orchestrator/orchestrator.module.js';

import { MuneraClient, type IMuneraClient, type MuneraLogger } from './munera.client.js';
import { UnconfiguredMuneraClient } from './munera-unconfigured.client.js';
import { MUNERA_CLIENT, MuneraAgentService } from './munera-agent.service.js';

function adaptLogger(pino: PinoLogger): MuneraLogger {
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
    MuneraAgentService,
    {
      provide: MUNERA_CLIENT,
      inject: [ConfigService, PinoLogger],
      useFactory: (config: ConfigService, pino: PinoLogger): IMuneraClient => {
        const ns = config.getOrThrow<MuneraConfig>(MUNERA_CONFIG);
        // A2-281: no credential ⇒ a client that says so, not one that sends a
        // placeholder to api.muneral.com and reports the 401 as an outage.
        if (ns.credential.token === null) {
          pino.warn(
            { source: ns.credential.source, detail: ns.credential.detail },
            'munera credential not configured — calls will answer unavailable',
          );
          return new UnconfiguredMuneraClient();
        }
        pino.info(
          { source: ns.credential.source, baseUrl: ns.baseUrl },
          'munera credential loaded',
        );
        return new MuneraClient({
          baseUrl: ns.baseUrl,
          apiToken: ns.credential.token,
          logger: adaptLogger(pino),
          timeoutMs: ns.timeoutMs,
          serviceName: 'arcanada-assistant',
        });
      },
    },
  ],
  exports: [MUNERA_CLIENT, MuneraAgentService],
})
export class MuneraAgentModule implements OnModuleInit {
  private readonly logger = new Logger(MuneraAgentModule.name);

  constructor(
    private readonly registry: AgentRegistry,
    private readonly agent: MuneraAgentService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const ns = this.config.getOrThrow<MuneraConfig>(MUNERA_CONFIG);
    if (!ns.integrationEnabled) {
      this.logger.warn('ECOSYSTEM_MUNERA_INTEGRATION=false — MuneraAgent not registered');
      return;
    }
    this.registry.register(this.agent);
  }
}

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';

import { CLAUDE_CONFIG, type ClaudeConfig } from '../../config/claude.config.js';

import { ClaudeClient, type ClaudeLogger, type IClaudeClient } from './claude.client.js';

export const CLAUDE_CLIENT = Symbol('CLAUDE_CLIENT');

function adaptLogger(pino: PinoLogger): ClaudeLogger {
  return {
    info: (obj, msg) => pino.info(obj, msg ?? ''),
    warn: (obj, msg) => pino.warn(obj, msg ?? ''),
    error: (obj, msg) => pino.error(obj, msg ?? ''),
    debug: (obj, msg) => pino.debug(obj, msg ?? ''),
  };
}

@Module({
  providers: [
    {
      provide: CLAUDE_CLIENT,
      inject: [ConfigService, PinoLogger],
      useFactory: (config: ConfigService, pino: PinoLogger): IClaudeClient => {
        const ns = config.getOrThrow<ClaudeConfig>(CLAUDE_CONFIG);
        return new ClaudeClient({
          baseUrl: ns.baseUrl,
          apiKey: ns.apiKey,
          defaultModel: ns.defaultModel,
          timeoutMs: ns.timeoutMs,
          logger: adaptLogger(pino),
        });
      },
    },
  ],
  exports: [CLAUDE_CLIENT],
})
export class ClaudeAgentModule {}

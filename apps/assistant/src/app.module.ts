import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { configurationSchema, validateConfig } from './config/configuration.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { WebhookModule } from './webhook/webhook.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: (env) => validateConfig(env),
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers["x-telegram-bot-api-secret-token"]',
            'req.headers.cookie',
            '*.DATABASE_URL',
            '*.REDIS_URL',
            '*.TELEGRAM_BOT_TOKEN',
            '*.TELEGRAM_WEBHOOK_SECRET',
            '*.OPSBOT_API_KEY',
          ],
          censor: '[REDACTED]',
        },
        transport:
          process.env.NODE_ENV === 'development'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
      },
    }),
    DatabaseModule,
    HealthModule,
    WebhookModule,
  ],
})
export class AppModule {
  static configurationSchema = configurationSchema;
}

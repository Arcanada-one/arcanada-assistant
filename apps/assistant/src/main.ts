import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    logger: false,
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: false,
  });

  app.useLogger(app.get(Logger));

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: [`'self'`],
        styleSrc: [`'self'`, `'unsafe-inline'`],
        imgSrc: [`'self'`, 'data:', 'https:'],
        scriptSrc: [`'self'`],
      },
    },
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
  });

  await app.register(rateLimit, {
    max: 30,
    timeWindow: '1 minute',
    allowList: ['127.0.0.1'],
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Arcanada Assistant')
    .setDescription('Единая точка входа в экосистему Arcanada')
    .setVersion('0.1.0')
    .addServer('https://assistant.arcanada.one')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  const port = Number(process.env.PORT ?? 3800);
  await app.listen(port, '0.0.0.0');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console -- pino logger may not be wired yet on bootstrap failure
  console.error('[bootstrap] fatal error before listen:', err);
  process.exit(1);
});

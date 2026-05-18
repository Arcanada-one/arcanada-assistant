import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import type { IOpsBotClient } from '@arcanada/core';

import { OPS_BOT_CLIENT } from '../agents/ops-agent/ops-agent.service.js';

const SERVICE_NAME = 'arcanada-assistant';

export interface FatalInterceptorOptions {
  maxPerWindow?: number;
  windowMs?: number;
}

export const FATAL_INTERCEPTOR_OPTIONS = Symbol.for('FATAL_INTERCEPTOR_OPTIONS');

@Injectable()
export class FatalInterceptor implements NestInterceptor {
  private readonly logger = new Logger(FatalInterceptor.name);
  private readonly emits: number[] = [];
  private readonly maxPerWindow: number;
  private readonly windowMs: number;

  constructor(
    @Inject(OPS_BOT_CLIENT) private readonly client: IOpsBotClient,
    @Optional() @Inject(FATAL_INTERCEPTOR_OPTIONS) opts?: FatalInterceptorOptions,
  ) {
    this.maxPerWindow = opts?.maxPerWindow ?? 10;
    this.windowMs = opts?.windowMs ?? 60_000;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((err: unknown) => {
        void this.tryEmit(err, context);
        return throwError(() => err);
      }),
    );
  }

  private async tryEmit(err: unknown, context: ExecutionContext): Promise<void> {
    if (!this.shouldEmit()) return;
    try {
      await this.client.emitEvent({
        service: SERVICE_NAME,
        category: 'fatal',
        severity: 'fatal',
        message: err instanceof Error ? err.message : String(err),
        context: {
          controller: safeName(context.getClass?.()),
          handler: safeName(context.getHandler?.()),
        },
      });
    } catch (emitErr) {
      this.logger.warn(
        { err: emitErr instanceof Error ? emitErr.message : String(emitErr) },
        'fatal interceptor emit failed',
      );
    }
  }

  private shouldEmit(): boolean {
    const now = Date.now();
    while (this.emits.length && now - this.emits[0] > this.windowMs) {
      this.emits.shift();
    }
    if (this.emits.length >= this.maxPerWindow) return false;
    this.emits.push(now);
    return true;
  }
}

function safeName(fn: { name?: string } | undefined): string {
  return fn?.name ?? 'unknown';
}

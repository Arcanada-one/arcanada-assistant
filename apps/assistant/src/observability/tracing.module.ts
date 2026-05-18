import { Module, type DynamicModule } from '@nestjs/common';

import { NoopTraceContext, TRACE_CONTEXT, type TraceContext } from './trace-context.js';

export interface TracingModuleOptions {
  factory?: () => TraceContext;
}

@Module({})
export class TracingModule {
  static forRoot(opts: TracingModuleOptions = {}): DynamicModule {
    const factory = opts.factory ?? (() => new NoopTraceContext());
    return {
      module: TracingModule,
      providers: [
        {
          provide: TRACE_CONTEXT,
          useFactory: factory,
        },
      ],
      exports: [TRACE_CONTEXT],
      global: true,
    };
  }
}

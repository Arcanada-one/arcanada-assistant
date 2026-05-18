import { BadRequestException, Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { z } from 'zod';

export const PROACTIVE_QUEUE = Symbol.for('PROACTIVE_QUEUE');

const TriggerSchema = z.object({
  kind: z.enum(['briefing', 'digest']),
});

export type TriggerRequest = z.infer<typeof TriggerSchema>;

@Controller('proactive')
export class ProactiveController {
  constructor(@Inject(PROACTIVE_QUEUE) private readonly queue: Queue) {}

  @Post('trigger')
  @HttpCode(202)
  async trigger(@Body() body: unknown): Promise<{ queued: true; jobId: string; kind: string }> {
    const parsed = TriggerSchema.safeParse(body);
    if (!parsed.success) {
      const reason = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new BadProactiveTriggerError(reason);
    }
    const job = await this.queue.add(
      parsed.data.kind,
      { kind: parsed.data.kind, manual: true },
      { jobId: `manual:${parsed.data.kind}:${Date.now()}` },
    );
    return { queued: true, jobId: String(job.id ?? ''), kind: parsed.data.kind };
  }
}

export class BadProactiveTriggerError extends BadRequestException {
  constructor(reason: string) {
    super(`invalid proactive trigger body: ${reason}`);
  }
}

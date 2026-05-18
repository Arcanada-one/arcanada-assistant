import { BadRequestException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { ProactiveController } from './proactive.controller.js';

function buildQueue(): Queue {
  return {
    add: vi.fn().mockResolvedValue({ id: 'job-1' }),
  } as unknown as Queue;
}

describe('ProactiveController', () => {
  it('queues briefing job and returns 202-shaped response', async () => {
    const queue = buildQueue();
    const ctrl = new ProactiveController(queue);
    const res = await ctrl.trigger({ kind: 'briefing' });
    expect(res.queued).toBe(true);
    expect(res.kind).toBe('briefing');
    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, payload] = (queue.add as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(name).toBe('briefing');
    expect((payload as { kind: string; manual: boolean }).kind).toBe('briefing');
    expect((payload as { kind: string; manual: boolean }).manual).toBe(true);
  });

  it('queues digest job', async () => {
    const queue = buildQueue();
    const ctrl = new ProactiveController(queue);
    const res = await ctrl.trigger({ kind: 'digest' });
    expect(res.kind).toBe('digest');
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown kind with 400 BadRequestException', async () => {
    const queue = buildQueue();
    const ctrl = new ProactiveController(queue);
    await expect(ctrl.trigger({ kind: 'something' })).rejects.toBeInstanceOf(BadRequestException);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rejects missing body with 400', async () => {
    const queue = buildQueue();
    const ctrl = new ProactiveController(queue);
    await expect(ctrl.trigger({})).rejects.toBeInstanceOf(BadRequestException);
  });
});

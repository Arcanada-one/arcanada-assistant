import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';

import { AgentRegistry } from '../../orchestrator/agent.registry.js';
import { DREAMER_CONFIG } from '../../config/dreamer.config.js';

import type { DreamerAgentService } from './dreamer-agent.service.js';
import { DreamerAgentModule } from './dreamer-agent.module.js';

function build({ live }: { live: boolean }) {
  const registry = new AgentRegistry();
  const agent = {
    name: 'dreamer',
    intents: [],
    execute: vi.fn(),
  } as unknown as DreamerAgentService;
  const config = {
    getOrThrow: vi.fn((key: string) => {
      if (key === DREAMER_CONFIG) return { live, timeoutMs: 15_000 };
      throw new Error(`unexpected config key: ${key}`);
    }),
  } as unknown as ConfigService;
  const module = new DreamerAgentModule(registry, agent, config);
  return { module, registry, agent };
}

describe('DreamerAgentModule.onModuleInit (AGENT-0030)', () => {
  it('does NOT register dreamer when ECOSYSTEM_DREAMER_LIVE=false (skeleton mode)', () => {
    const { module, registry } = build({ live: false });
    module.onModuleInit();
    expect(registry.list().map((a) => a.name)).not.toContain('dreamer');
    expect(registry.list()).toHaveLength(0);
  });

  it('registers dreamer when ECOSYSTEM_DREAMER_LIVE=true (forward-compat for AGENT-0062)', () => {
    const { module, registry } = build({ live: true });
    module.onModuleInit();
    expect(registry.list().map((a) => a.name)).toContain('dreamer');
  });
});

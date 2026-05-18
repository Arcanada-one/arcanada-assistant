import { Controller, Get, HttpCode, NotFoundException, Param, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { AgentRegistry } from '../orchestrator/agent.registry.js';
import { isAgentHealth, type AgentHealthSnapshot } from '../aal/agent-health.types.js';

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

@ApiTags('health')
@Controller('v1/agents')
export class AgentPingController {
  constructor(private readonly registry: AgentRegistry) {}

  @Get(':name/ping')
  @HttpCode(200)
  async ping(
    @Param('name') name: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AgentHealthSnapshot> {
    if (!NAME_PATTERN.test(name)) {
      throw new NotFoundException(`agent name "${name}" is not a valid identifier`);
    }
    const agent = this.registry.list().find((a) => a.name === name);
    if (!agent) throw new NotFoundException(`agent "${name}" not registered`);

    if (!isAgentHealth(agent)) {
      return {
        agent: agent.name,
        state: 'ok',
        checkedAt: new Date().toISOString(),
      };
    }

    const snapshot = await agent.healthSnapshot();
    if (snapshot.state === 'unavailable') reply.status(503);
    else if (snapshot.state === 'degraded') reply.status(207);
    return snapshot;
  }
}

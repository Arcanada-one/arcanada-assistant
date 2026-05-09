import { Injectable } from '@nestjs/common';

/**
 * Hub-and-spoke `IAgent` contract (ADR-002, creative-ARCA-0005).
 * Each agent declares the intents it claims; the registry guarantees a single
 * owner per intent and the orchestrator dispatches by lookup, not iteration.
 */
export interface IAgent {
  readonly name: string;
  readonly intents: readonly string[];
  execute(intent: string, payload?: unknown): Promise<unknown>;
}

@Injectable()
export class AgentRegistry {
  private readonly byName = new Map<string, IAgent>();
  private readonly byIntent = new Map<string, IAgent>();

  register(agent: IAgent): void {
    for (const intent of agent.intents) {
      const existing = this.byIntent.get(intent);
      if (existing && existing !== agent) {
        throw new Error(
          `Intent ${intent} already registered by agent "${existing.name}"; refused for "${agent.name}"`,
        );
      }
    }
    this.byName.set(agent.name, agent);
    for (const intent of agent.intents) this.byIntent.set(intent, agent);
  }

  resolve(intent: string): IAgent | undefined {
    return this.byIntent.get(intent);
  }

  list(): IAgent[] {
    return [...this.byName.values()];
  }
}

/**
 * ARCA-0009 M8 D1+D2 — per-agent health surface (V-AC-7 / V-AC-8).
 *
 * Agents that talk to external services SHOULD implement `IAgentHealth` so
 * the orchestrator can roll up a per-agent block in `/health` JSON and a
 * synthetic `ping` smoke endpoint can exercise each agent in isolation. The
 * interface is intentionally narrow: the agent reports its current circuit
 * breaker / connectivity state without making a live external call.
 *
 * For a live probe call site, use the smoke ping controller — `IAgentHealth`
 * is the cheap path-of-record observation used by liveness/readiness.
 */

export type AgentHealthState = 'ok' | 'degraded' | 'unavailable';
export type AgentCircuitState = 'closed' | 'half-open' | 'open';

export interface AgentHealthSnapshot {
  readonly agent: string;
  readonly state: AgentHealthState;
  readonly circuit?: AgentCircuitState;
  readonly reason?: string;
  readonly checkedAt: string;
}

export interface IAgentHealth {
  /** Cheap, non-network-call summary of the agent's last-known status. */
  healthSnapshot(): AgentHealthSnapshot | Promise<AgentHealthSnapshot>;
}

export function isAgentHealth(agent: unknown): agent is IAgentHealth {
  return (
    !!agent &&
    typeof agent === 'object' &&
    typeof (agent as IAgentHealth).healthSnapshot === 'function'
  );
}

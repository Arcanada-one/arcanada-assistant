import type { IHttpHealthClient } from '@arcanada/core';

/**
 * DI tokens for the upstream liveness-probe clients consumed by
 * {@link HealthController}. Both resolve to `IHttpHealthClient`
 * instances configured against the respective upstream's public `/health`
 * surface. OpsBot reuses the existing `OPS_BOT_CLIENT` token (it already has a
 * structured `ping()`), so only Model Connector and Auth Arcana need new tokens.
 */
export const MODEL_CONNECTOR_HEALTH_CLIENT = Symbol.for('MODEL_CONNECTOR_HEALTH_CLIENT');
export const AUTH_ARCANA_HEALTH_CLIENT = Symbol.for('AUTH_ARCANA_HEALTH_CLIENT');

export type IUpstreamHealthClient = IHttpHealthClient;

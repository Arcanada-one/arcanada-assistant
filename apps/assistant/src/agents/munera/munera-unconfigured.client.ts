import type { IMuneraClient } from './munera.client.js';
import type { TaskListResult, TaskPageResult, TaskResult } from './munera.schemas.js';

/**
 * A2-281 — the client used when no Muneral credential is configured.
 *
 * Production ran with `MUNERA_API_TOKEN=changeme` for months. A placeholder is
 * not a credential, and the honest thing for a call made with one is to say so
 * at the call site, not to send `Bearer changeme` to api.muneral.com and let a
 * 401 stand in for "nobody installed the key".
 *
 * Every method answers the `unavailable` arm the callers already handle, with
 * a reason that names the fix. Nothing here reaches the network.
 */
export const MUNERA_CREDENTIAL_NOT_CONFIGURED = 'munera_credential_not_configured';

const unavailable = {
  kind: 'unavailable' as const,
  reason: MUNERA_CREDENTIAL_NOT_CONFIGURED,
  detail: 'set MUNERAL_AGENT_KEY_FILE to a file holding the agent key (mun_sk_…)',
};

export class UnconfiguredMuneraClient implements IMuneraClient {
  /** True, so callers that gate on the breaker also stop before the network. */
  isCircuitOpen(): boolean {
    return true;
  }

  createTask(): Promise<TaskResult> {
    return Promise.resolve(unavailable);
  }

  updateTaskStatus(): Promise<TaskResult> {
    return Promise.resolve(unavailable);
  }

  getTask(): Promise<TaskResult> {
    return Promise.resolve(unavailable);
  }

  listTasksByProject(): Promise<TaskListResult> {
    return Promise.resolve(unavailable);
  }

  queryTasks(): Promise<TaskPageResult> {
    return Promise.resolve(unavailable);
  }
}

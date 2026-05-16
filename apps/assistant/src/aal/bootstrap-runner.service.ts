import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

import { BootstrapCredentialRegistry } from './bootstrap-credential.js';

/**
 * Drives `BootstrapCredentialRegistry.runAll()` on Nest's
 * `onApplicationBootstrap` lifecycle hook so probes execute exactly once
 * per process start, after every module's providers have been instantiated.
 */
@Injectable()
export class BootstrapCredentialRunner implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootstrapCredentialRunner.name);

  constructor(private readonly registry: BootstrapCredentialRegistry) {}

  async onApplicationBootstrap(): Promise<void> {
    const probes = this.registry.list();
    if (probes.length === 0) {
      this.logger.log('no bootstrap credential probes registered — skipping');
      return;
    }
    this.logger.log(`running ${probes.length} bootstrap credential probe(s)…`);
    const results = await this.registry.runAll();
    const failed = results.filter((r) => !r.outcome.ok);
    if (failed.length === 0) {
      this.logger.log('bootstrap credential probes — all ok');
      return;
    }
    this.logger.warn(
      `bootstrap credential probes — ${failed.length} of ${results.length} failed (non-blocking)`,
    );
  }
}

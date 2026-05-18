import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Logger, Module, type OnModuleInit } from '@nestjs/common';

import { loadApprovalPolicyFromFile } from './approval-policy.loader.js';
import type { ApprovalPolicy } from './approval-policy.schema.js';
import { APPROVAL_POLICY, ApprovalService } from './approval.service.js';
import { RedisIdempotencyService } from './redis-idempotency.service.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY_PATH = join(HERE, 'agent-approval-policy.yaml');

@Module({
  providers: [
    RedisIdempotencyService,
    {
      provide: APPROVAL_POLICY,
      useFactory: async (): Promise<ApprovalPolicy> => {
        const path = process.env.AGENT_APPROVAL_POLICY_PATH ?? DEFAULT_POLICY_PATH;
        return loadApprovalPolicyFromFile(path);
      },
    },
    {
      provide: ApprovalService,
      inject: [APPROVAL_POLICY, RedisIdempotencyService],
      useFactory: (policy: ApprovalPolicy, redis: RedisIdempotencyService): ApprovalService =>
        ApprovalService.withDeps(policy, redis),
    },
  ],
  exports: [ApprovalService, RedisIdempotencyService, APPROVAL_POLICY],
})
export class ApprovalModule implements OnModuleInit {
  private readonly logger = new Logger(ApprovalModule.name);

  onModuleInit(): void {
    this.logger.log(
      `approval framework initialised (policy: ${
        process.env.AGENT_APPROVAL_POLICY_PATH ?? DEFAULT_POLICY_PATH
      })`,
    );
  }
}

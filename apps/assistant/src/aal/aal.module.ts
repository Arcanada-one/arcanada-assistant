import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Module, type DynamicModule, type FactoryProvider } from '@nestjs/common';

import { BootstrapCredentialRegistry } from './bootstrap-credential.js';
import { BootstrapCredentialRunner } from './bootstrap-runner.service.js';
import { ScopeGuard } from './scope-guard.js';
import { loadScopeManifestFromFile } from './scope.loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCOPE_PATH = path.resolve(__dirname, 'agent-scopes.yaml');

export interface AalModuleOptions {
  scopeManifestPath?: string;
}

const scopeGuardProvider = (opts?: AalModuleOptions): FactoryProvider<ScopeGuard> => ({
  provide: ScopeGuard,
  useFactory: async () => {
    const guardPath = opts?.scopeManifestPath ?? DEFAULT_SCOPE_PATH;
    const manifest = await loadScopeManifestFromFile(guardPath);
    const guard = new ScopeGuard();
    guard.load(manifest);
    return guard;
  },
});

@Module({})
export class AalModule {
  static forRoot(opts?: AalModuleOptions): DynamicModule {
    return {
      module: AalModule,
      providers: [scopeGuardProvider(opts), BootstrapCredentialRegistry, BootstrapCredentialRunner],
      exports: [ScopeGuard, BootstrapCredentialRegistry],
      global: true,
    };
  }
}

import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuthDispatcher } from './auth.dispatcher.js';
import {
  AUTH_ARCANA_JWT_OPTIONS,
  AUTH_ARCANA_JWT_VERIFIER,
  AuthArcanaJwtStrategy,
  type AuthArcanaJwtStrategyOptions,
  type AuthArcanaJwtVerifier,
} from './auth-arcana-jwt.strategy.js';
import { AUTH_STRATEGY } from './auth-strategy.interface.js';
import { TailscaleStrategy } from './tailscale.strategy.js';
import {
  VAULT_API_KEY_VERIFIER,
  VaultApiKeyStrategy,
  type VaultApiKeyVerifier,
} from './vault-api-key.strategy.js';

/**
 * Default Vault verifier — placeholder until AUTH-* mints real per-service
 * keys. Recognises a single env-injected key (`MESH_VAULT_API_KEY`) and maps
 * it to `svc:assistant`. Real Vault lookup arrives in a follow-up task.
 */
class EnvVaultApiKeyVerifier implements VaultApiKeyVerifier {
  constructor(private readonly expectedKey: string | undefined) {}

  verify(key: string): Promise<{ ok: true; principal: string } | { ok: false; reason: string }> {
    if (!this.expectedKey || this.expectedKey.length === 0) {
      return Promise.resolve({ ok: false, reason: 'no_key_configured' });
    }
    if (key === this.expectedKey) {
      return Promise.resolve({ ok: true, principal: 'svc:assistant' });
    }
    return Promise.resolve({ ok: false, reason: 'key_mismatch' });
  }
}

/**
 * Default Auth Arcana JWT verifier — `Unimplemented` until AUTH-* phases
 * ship and the assistant flips `MESH_AUTH_ARCANA_JWT=true`. The strategy
 * itself is wired so DI surface stays stable; the verifier just refuses.
 */
class UnimplementedAuthArcanaJwtVerifier implements AuthArcanaJwtVerifier {
  verify(): Promise<{ ok: false; reason: string }> {
    return Promise.resolve({ ok: false, reason: 'auth_arcana_jwt_verifier_not_wired' });
  }
}

const strategiesProvider: Provider = {
  provide: AUTH_STRATEGY,
  inject: [TailscaleStrategy, VaultApiKeyStrategy, AuthArcanaJwtStrategy],
  useFactory: (
    tailscale: TailscaleStrategy,
    vault: VaultApiKeyStrategy,
    jwt: AuthArcanaJwtStrategy,
  ) => [jwt, vault, tailscale],
};

const vaultVerifierProvider: Provider = {
  provide: VAULT_API_KEY_VERIFIER,
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    new EnvVaultApiKeyVerifier(config.get<string>('MESH_VAULT_API_KEY')),
};

const jwtOptionsProvider: Provider = {
  provide: AUTH_ARCANA_JWT_OPTIONS,
  inject: [ConfigService],
  useFactory: (config: ConfigService): AuthArcanaJwtStrategyOptions => ({
    enabled: config.get<boolean>('MESH_AUTH_ARCANA_JWT') ?? false,
  }),
};

const jwtVerifierProvider: Provider = {
  provide: AUTH_ARCANA_JWT_VERIFIER,
  useFactory: () => new UnimplementedAuthArcanaJwtVerifier(),
};

@Module({
  providers: [
    TailscaleStrategy,
    VaultApiKeyStrategy,
    AuthArcanaJwtStrategy,
    vaultVerifierProvider,
    jwtOptionsProvider,
    jwtVerifierProvider,
    strategiesProvider,
    AuthDispatcher,
  ],
  exports: [AuthDispatcher, AUTH_STRATEGY],
})
export class AuthModule {
  static forRoot(): DynamicModule {
    return {
      module: AuthModule,
      global: true,
    };
  }
}

import { createRemoteJWKSet, jwtVerify, importJWK, type JWK, type JWTPayload } from 'jose';

/**
 * Pluggable JWKS provider — swap real remote JWKS (production) with static
 * in-memory JWKS (tests). Both flows ultimately materialise a key for `kid`.
 */
export interface JwksProvider {
  getKey(kid: string): Promise<JWK>;
}

/**
 * Production JWKS provider. Wraps `jose.createRemoteJWKSet` (caches keys 10 min,
 * refetches on cache miss). Auth Arcana publishes its keys at the `jwksUrl`
 * passed in (typically `https://auth.arcanada.one/.well-known/jwks.json`).
 */
export class RemoteJwksProvider implements JwksProvider {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(jwksUrl: URL, opts: { cacheMaxAgeMs?: number; cooldownMs?: number } = {}) {
    this.jwks = createRemoteJWKSet(jwksUrl, {
      cacheMaxAge: opts.cacheMaxAgeMs ?? 10 * 60 * 1000,
      cooldownDuration: opts.cooldownMs ?? 30 * 1000,
    });
  }

  // We expose `getKey` to satisfy `JwksProvider`, but in practice the
  // production path uses the bound resolver directly via `jwtVerify`.
  async getKey(_kid: string): Promise<JWK> {
    throw new Error('RemoteJwksProvider exposes resolver via JwtValidator, not getKey');
  }

  /** Internal — used by `JwtValidator` when it detects a remote provider. */
  get resolver(): ReturnType<typeof createRemoteJWKSet> {
    return this.jwks;
  }
}

export interface JwtValidatorOptions {
  jwks: JwksProvider;
  issuer: string;
  audience: string;
  /** Whitelist of accepted algorithms. Defaults to RS256 + ES256 (rejects `none`). */
  allowedAlgorithms?: string[];
}

export interface VerifiedJwt extends JWTPayload {
  sub: string;
}

/**
 * Validates JWTs against an Auth Arcana JWKS endpoint. Fail-closed on any
 * malformed/expired/wrong-issuer/wrong-audience input.
 */
export class JwtValidator {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly algorithms: string[];
  private readonly jwks: JwksProvider;

  constructor(opts: JwtValidatorOptions) {
    this.jwks = opts.jwks;
    this.issuer = opts.issuer;
    this.audience = opts.audience;
    this.algorithms = opts.allowedAlgorithms ?? ['RS256', 'ES256'];
  }

  async verify(token: string): Promise<VerifiedJwt> {
    const keyResolver =
      this.jwks instanceof RemoteJwksProvider
        ? this.jwks.resolver
        : async (header: { kid?: string; alg?: string }) => {
            if (!header.kid) throw new Error('JWT header missing kid');
            const jwk = await this.jwks.getKey(header.kid);
            return await importJWK(jwk, header.alg ?? this.algorithms[0]);
          };

    const { payload } = await jwtVerify(token, keyResolver, {
      issuer: this.issuer,
      audience: this.audience,
      algorithms: this.algorithms,
    });

    if (typeof payload.sub !== 'string') {
      throw new Error('JWT payload missing sub claim');
    }

    return payload as VerifiedJwt;
  }
}

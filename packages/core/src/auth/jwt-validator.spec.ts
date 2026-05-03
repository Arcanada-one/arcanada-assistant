import { describe, it, expect, beforeAll } from 'vitest';
import {
  generateKeyPair,
  SignJWT,
  exportJWK,
  type JWK,
  type KeyLike,
} from 'jose';

import { JwtValidator, type JwksProvider } from './jwt-validator.js';

const ISSUER = 'https://auth.arcanada.one';
const AUDIENCE = 'arcanada-assistant';

class StaticJwks implements JwksProvider {
  constructor(private readonly jwk: JWK & { kid: string }) {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getKey(_kid: string): Promise<JWK> {
    return this.jwk;
  }
}

async function makeKeyPair() {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'test-key';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  return { publicKey, privateKey, publicJwk: publicJwk as JWK & { kid: string } };
}

async function signToken(
  privateKey: KeyLike,
  payload: Record<string, unknown>,
  opts: { issuer?: string; audience?: string; expiresIn?: string } = {},
): Promise<string> {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuedAt()
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setExpirationTime(opts.expiresIn ?? '5m')
    .sign(privateKey);
}

describe('JwtValidator', () => {
  let publicJwk: JWK & { kid: string };
  let privateKey: KeyLike;
  let validator: JwtValidator;

  beforeAll(async () => {
    const kp = await makeKeyPair();
    publicJwk = kp.publicJwk;
    privateKey = kp.privateKey;
    validator = new JwtValidator({
      jwks: new StaticJwks(publicJwk),
      issuer: ISSUER,
      audience: AUDIENCE,
    });
  });

  it('accepts a valid signed JWT and returns payload', async () => {
    const token = await signToken(privateKey, { sub: 'user-123', scope: 'mc:execute' });
    const result = await validator.verify(token);
    expect(result.sub).toBe('user-123');
    expect(result.scope).toBe('mc:execute');
    expect(result.iss).toBe(ISSUER);
    expect(result.aud).toBe(AUDIENCE);
  });

  it('rejects expired token', async () => {
    const token = await signToken(privateKey, { sub: 'user-123' }, { expiresIn: '-1s' });
    await expect(validator.verify(token)).rejects.toThrow(/exp|expired/i);
  });

  it('rejects token with wrong issuer', async () => {
    const token = await signToken(privateKey, { sub: 'user-123' }, { issuer: 'https://evil.example' });
    await expect(validator.verify(token)).rejects.toThrow(/iss|issuer/i);
  });

  it('rejects token with wrong audience', async () => {
    const token = await signToken(
      privateKey,
      { sub: 'user-123' },
      { audience: 'some-other-service' },
    );
    await expect(validator.verify(token)).rejects.toThrow(/aud|audience/i);
  });

  it('rejects malformed token', async () => {
    await expect(validator.verify('not-a-jwt')).rejects.toThrow();
  });

  it('rejects token without sub claim', async () => {
    // Sign a token that has issuer/audience/exp but no sub.
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('1m')
      .sign(privateKey);
    await expect(validator.verify(token)).rejects.toThrow(/sub/i);
  });

  it('rejects token whose header omits kid', async () => {
    // Hand-sign without kid — JwksProvider.getKey requires kid.
    const token = await new SignJWT({ sub: 'x' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('1m')
      .sign(privateKey);
    await expect(validator.verify(token)).rejects.toThrow(/kid/i);
  });

  it('rejects token signed with `none` algorithm (alg whitelist)', async () => {
    // Manually craft an unsigned `alg: none` token — must be rejected.
    const header = Buffer.from(JSON.stringify({ alg: 'none', kid: 'test-key' })).toString(
      'base64url',
    );
    const payload = Buffer.from(
      JSON.stringify({ sub: 'attacker', iss: ISSUER, aud: AUDIENCE, exp: 9999999999 }),
    ).toString('base64url');
    const token = `${header}.${payload}.`;
    await expect(validator.verify(token)).rejects.toThrow();
  });
});

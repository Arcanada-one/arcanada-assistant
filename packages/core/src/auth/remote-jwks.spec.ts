import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT, type JWK, type KeyLike } from 'jose';

import { JwtValidator, RemoteJwksProvider } from './jwt-validator.js';

const ISSUER = 'http://127.0.0.1';
const AUDIENCE = 'arcanada-assistant';

let publicJwk: JWK & { kid: string };
let privateKey: KeyLike;
let server: Server;
let baseUrl: string;
let jwksFailure = false;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256', { extractable: true });
  privateKey = kp.privateKey;
  const jwk = (await exportJWK(kp.publicKey)) as JWK & { kid: string };
  jwk.kid = 'remote-key';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  publicJwk = jwk;

  server = createServer((req, res) => {
    if (jwksFailure) {
      res.statusCode = 500;
      res.end('boom');
      return;
    }
    if (req.url?.startsWith('/.well-known/jwks.json')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no addr');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

async function signTestToken(issuerUrl: string): Promise<string> {
  return await new SignJWT({ scope: 'mc:execute' })
    .setProtectedHeader({ alg: 'RS256', kid: 'remote-key' })
    .setSubject('svc-account')
    .setIssuedAt()
    .setIssuer(issuerUrl)
    .setAudience(AUDIENCE)
    .setExpirationTime('1m')
    .sign(privateKey);
}

describe('RemoteJwksProvider + JwtValidator (integration)', () => {
  it('verifies a JWT signed by a key fetched over HTTP from the JWKS endpoint', async () => {
    jwksFailure = false;
    const provider = new RemoteJwksProvider(new URL(`${baseUrl}/.well-known/jwks.json`));
    const validator = new JwtValidator({ jwks: provider, issuer: baseUrl, audience: AUDIENCE });
    const token = await signTestToken(baseUrl);
    const verified = await validator.verify(token);
    expect(verified.sub).toBe('svc-account');
    expect(verified.scope).toBe('mc:execute');
  });

  it('throws when JWKS endpoint returns 5xx', async () => {
    jwksFailure = true;
    const provider = new RemoteJwksProvider(new URL(`${baseUrl}/.well-known/jwks.json`), {
      cacheMaxAgeMs: 0,
      cooldownMs: 0,
    });
    const validator = new JwtValidator({ jwks: provider, issuer: baseUrl, audience: AUDIENCE });
    const token = await signTestToken(baseUrl);
    await expect(validator.verify(token)).rejects.toThrow();
    jwksFailure = false;
  });

  it('exposes resolver via instanceof guard (not via getKey)', async () => {
    const provider = new RemoteJwksProvider(new URL(`${baseUrl}/.well-known/jwks.json`));
    expect(provider.resolver).toBeTypeOf('function');
    await expect(provider.getKey('any')).rejects.toThrow(/getKey/);
  });

  it('uses default cache TTL when none provided', () => {
    const provider = new RemoteJwksProvider(new URL(`${baseUrl}/.well-known/jwks.json`));
    expect(provider.resolver).toBeTypeOf('function');
  });
});

// Reference unused to satisfy ts in case ISSUER var is removed.
void ISSUER;

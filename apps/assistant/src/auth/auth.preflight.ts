import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { AgentAuthError } from '../aal/exceptions.js';

import type { AuthDispatcher } from './auth.dispatcher.js';
import type { AuthPrincipal } from './auth-strategy.interface.js';

declare module 'fastify' {
  interface FastifyRequest {
    authPrincipal?: AuthPrincipal;
  }
}

export interface AuthPreflightOptions {
  /**
   * Routes that bypass auth (unauthenticated by design). Webhook + health +
   * docs are the canonical set. Matching is exact path prefix.
   */
  publicPrefixes: readonly string[];
}

const DEFAULT_PUBLIC_PREFIXES = ['/health', '/docs', '/webhook'];

/**
 * Fastify `preHandler` hook that runs the auth dispatcher on every request.
 * `req.authPrincipal` is decorated with the resolved principal; downstream
 * controllers / scope guards read from there. Public prefixes (health,
 * webhook, swagger docs) bypass auth.
 *
 * Per CLAUDE.md feedback `nestjs11_middleware_wildcard`: we install this
 * via Fastify hook (not NestJS `forRoutes('*')`) because `path-to-regexp v8`
 * silently binds wildcards to zero routes in Nest 11.
 */
export function registerAuthPreflight(
  app: FastifyInstance,
  dispatcher: AuthDispatcher,
  opts: AuthPreflightOptions = { publicPrefixes: DEFAULT_PUBLIC_PREFIXES },
): void {
  const publicPrefixes = [...opts.publicPrefixes];
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url || '/';
    if (publicPrefixes.some((p) => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`))) {
      return;
    }
    try {
      const principal = await dispatcher.authenticate({
        headers: req.headers as Record<string, string | string[] | undefined>,
        ip: req.ip,
      });
      if (!principal) {
        await reply.code(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'no auth credentials presented',
        });
        return;
      }
      req.authPrincipal = principal;
      reply.header('x-auth-strategy', principal.strategy);
    } catch (err) {
      if (err instanceof AgentAuthError) {
        await reply.code(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: err.message,
        });
        return;
      }
      throw err;
    }
  });
}

/**
 * Fail-closed reads for connection-bearing environment variables (A2-226).
 *
 * `process.env.X ?? '<localhost default>'` in a service constructor is a silent
 * production-connect hazard on this deployment. The assistant, its Postgres and
 * its Redis share a host and publish on loopback (docker-compose.yml:15, :38),
 * so a localhost default points a process that merely *forgot* a variable
 * straight at production instead of failing. An empty string is not inert
 * either: node-postgres resolves `connectionString: ''` to the ambient libpq
 * defaults — localhost:5432 as the OS user — which is the same target.
 *
 * `configurationSchema` (./configuration.ts) already rejects DATABASE_URL and
 * REDIS_URL when unset, and on the app's only entrypoint it fires first. That
 * guarantee is non-local, though: it holds because AppModule happens to import
 * ConfigModule.forRoot ahead of DatabaseModule. Nothing at the point of use
 * enforces it, so any future entrypoint that builds these services outside
 * AppModule — a queue worker, a CLI, a standalone Nest context — reopens the
 * hazard silently. These helpers move the guarantee to the line that needs it,
 * and make the refusal name the variable an operator has to set.
 *
 * Behaviour when the variable IS set is unchanged: the value is returned as-is.
 */

/** Thrown when a required environment variable is absent or blank. */
export class MissingEnvError extends Error {
  constructor(readonly variable: string) {
    super(
      `${variable} is not set. Refusing to start rather than fall back to a ` +
        `local default, which on this host would be the production service.`,
    );
    this.name = 'MissingEnvError';
  }
}

/**
 * Read a required environment variable. Throws {@link MissingEnvError} naming
 * the variable when it is absent, empty or whitespace-only — never substitutes
 * a default.
 */
export function requireEnv(variable: string): string {
  const value = process.env[variable];
  if (value === undefined || value.trim() === '') {
    throw new MissingEnvError(variable);
  }
  return value;
}

import { readFile } from 'node:fs/promises';

import { JSON_SCHEMA, load as yamlLoad } from 'js-yaml';

import { ScopeManifestSchema, type ScopeManifest } from './scope.schema.js';

export class ScopeManifestLoadError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ScopeManifestLoadError';
    this.cause = cause;
  }
}

export async function loadScopeManifestFromFile(path: string): Promise<ScopeManifest> {
  let raw: string;
  try {
    // Path comes from operator-controlled env var / DI factory default;
    // not user-supplied input. Suppressing the non-literal-filename rule here is safe.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new ScopeManifestLoadError(`unable to read scope manifest: ${path}`, err);
  }
  return parseScopeManifest(raw);
}

export function parseScopeManifest(yaml: string): ScopeManifest {
  let doc: unknown;
  try {
    doc = yamlLoad(yaml, { schema: JSON_SCHEMA });
  } catch (err) {
    throw new ScopeManifestLoadError('YAML parse failed', err);
  }
  const parsed = ScopeManifestSchema.safeParse(doc);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ScopeManifestLoadError(`scope manifest invalid: ${issues}`, parsed.error);
  }
  return parsed.data;
}

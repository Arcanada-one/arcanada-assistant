import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A2-222 — what this process was built from, as a digest the deploy can compare against.
 *
 * WHY THIS EXISTS. The deploy's post-`up` gate was `arcanada-compose-broker arcanada-assistant
 * freshness` (`.github/workflows/ci.yml`), which asserts that the container is younger than the
 * broker's MAXAGE. That is a proxy for "the deploy recreated the container", and it breaks in the
 * direction that costs the most: a merge that changes no file the image is built from (docs,
 * `.github/`, `ops/`) produces a byte-identical image, compose correctly leaves the running
 * container alone, and the gate calls the deploy failed although production is running exactly
 * the code that commit contains. Measured on argana with the same broker verb, 2026-09-23:
 * `container argana-argana-1 is 2197s old (limit 600s)` on a merge whose image was identical.
 * A red everyone knows to ignore is how a real one gets ignored.
 *
 * The claim a deploy actually has to make is **"the process serving traffic was built from THIS
 * commit's image inputs"**, not "the container is young".
 *
 * SOURCES, AT RUNTIME — and why that is the right choice HERE. `apps/assistant/Dockerfile` is a
 * single stage: it `COPY`s `packages/core` and `apps/assistant` into `/workspace` and builds in
 * place, so the TypeScript this image was built from is still on disk in the running container
 * and can be hashed directly. (Ops Bot's multi-stage image is the opposite case and had to bake
 * the digest at build time.) Hashing the built `dist/` instead would force CI to reproduce a `tsc`
 * byte-for-byte to compute the expectation, which nothing should have to rely on.
 *
 *   equal      → the process serving traffic was built from this commit's inputs. PASS, whether
 *                or not anything was recreated — the docs-only deploy that recreated nothing is
 *                a correct deploy.
 *   different  → the container is running some other build. FAIL, the failure the age check was
 *                reaching for.
 *   no digest  → FAIL as `could not prove`. Not measured is the third verdict, never a pass.
 *
 * WHY THE `Dockerfile` NEEDS NO SPECIAL HANDLING. It lives at `apps/assistant/Dockerfile`, inside
 * a declared input, so `COPY apps/assistant ./apps/assistant` already puts it in the image and
 * this digest already covers it. A commit that changes only the `CMD` builds a new image AND
 * moves the digest, so a container never recreated onto it cannot pass. argana had to copy its
 * Dockerfile into the image on purpose to get this property; here the layout gives it for free.
 *
 * WHAT THIS DOES NOT COVER, stated rather than implied. `docker-compose.yml` and the root-owned
 * deploy env file decide the CONTAINER (ports, env, the postgres volume) rather than the IMAGE
 * and are not copied into it, so container-level drift is `not_measured` here. Neither is the
 * resolved `node_modules` tree: `pnpm-lock.yaml` is an input, the installed result is not.
 */

export const DIGEST_ALGORITHM = 'sha256';

/**
 * The files the image is built from, relative to the build context root — and, after `COPY`,
 * relative to `/workspace` inside the container. Kept in ONE place and held against the
 * Dockerfile's own `COPY` instructions by `build-fingerprint.spec.ts`, so adding a `COPY` without
 * adding it here is a red test rather than a quiet hole in the gate.
 */
export const IMAGE_INPUTS: readonly string[] = [
  'apps/assistant',
  'package.json',
  'packages/core',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'tsconfig.json',
];

/**
 * Artefacts that exist on one side of the comparison and not the other and say nothing about the
 * code. These are load-bearing here, not tidiness — unlike a multi-stage build, this image builds
 * IN PLACE inside the directories being hashed:
 *
 *  * `dist` — `pnpm --filter … build` writes `apps/assistant/dist` and `packages/core/dist`
 *    INSIDE the fingerprinted tree, and a fresh CI checkout has neither;
 *  * `node_modules` — `pnpm install` links `apps/assistant/node_modules` and
 *    `packages/core/node_modules` into the workspace store, again inside the tree;
 *  * `.tsbuildinfo` — `tsconfig.json` points it at `./dist/.tsbuildinfo`, but a stray one outside
 *    `dist` must not move the digest either.
 *
 * Hashing any of these would make EVERY deploy red for a reason that is not a deploy fault.
 *
 * The first five also mirror the recursive entries in `.dockerignore` (node_modules, dist,
 * coverage, .turbo, .next), which is the other direction of the same requirement: a file the
 * build context never received cannot exist on the image side, so CI must not hash it either.
 * `build-fingerprint.spec.ts` holds that correspondence, so loosening `.dockerignore` without
 * loosening this list is a red test.
 */
export const IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.turbo',
  '.next',
  '.git',
  '__pycache__',
]);
export const IGNORED_SUFFIXES: readonly string[] = ['.tsbuildinfo', '.log'];
export const IGNORED_FILE_NAMES: ReadonlySet<string> = new Set(['.DS_Store']);

export interface BuildFingerprint {
  digest: string | null;
  files: number;
  root: string;
  inputs: string[];
  problems: string[];
}

/** Judged on the path RELATIVE to the root, never the absolute one: a checkout that happens to
 * live under a directory called `dist` must not silently fingerprint to nothing. */
export function isIgnored(relativePosixPath: string): boolean {
  const parts = relativePosixPath.split('/');
  const name = parts[parts.length - 1] ?? '';
  if (IGNORED_FILE_NAMES.has(name)) return true;
  if (IGNORED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  return parts.some((part) => IGNORED_DIR_NAMES.has(part));
}

/**
 * `/workspace` in the container, the repository root in a checkout — derived, never configured.
 *
 * The walk looks for `pnpm-workspace.yaml`, which is itself one of the image inputs and therefore
 * present on both sides. `__dirname` cannot be used the way argana uses it, because this module
 * sits at `apps/assistant/src/health/` in a checkout and at `apps/assistant/dist/health/` in the
 * image — different paths, same ancestor. A setting would be worse than either: it could be set
 * to different values on the two sides of a comparison whose whole point is that they cannot.
 */
export function workspaceRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let current = from;
  for (;;) {
    try {
      if (statSync(join(current, 'pnpm-workspace.yaml')).isFile()) return current;
    } catch {
      /* keep walking */
    }
    const parent = dirname(current);
    if (parent === current) return from;
    current = parent;
  }
}

function filesUnder(root: string, entry: string, problems: string[]): Array<[string, string]> {
  const target = join(root, ...entry.split('/'));
  let info;
  try {
    info = statSync(target);
  } catch {
    problems.push(`declared image input '${entry}' is missing at ${root}`);
    return [];
  }
  if (info.isFile()) return [[entry, target]];
  if (!info.isDirectory()) {
    problems.push(`declared image input '${entry}' is neither a file nor a directory at ${root}`);
    return [];
  }

  const found: Array<[string, string]> = [];
  const walk = (dir: string): void => {
    const children = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    );
    for (const child of children) {
      const full = join(dir, child.name);
      const rel = relative(root, full).split(sep).join('/');
      if (isIgnored(rel)) continue;
      if (child.isDirectory()) walk(full);
      else if (child.isFile()) found.push([rel, full]);
    }
  };
  walk(target);
  if (found.length === 0) problems.push(`declared image input '${entry}' is an empty directory`);
  return found;
}

/**
 * Digest IMAGE_INPUTS under `root`. Never throws — every failure becomes a `problems` entry and a
 * null digest, because a gate that cannot prove its claim must say so rather than throw inside a
 * health check that a container restart loop depends on.
 *
 * The digest binds each file's path to its content (`path NUL sha256 NUL`, in sorted path order),
 * so a renamed or moved file changes it as surely as an edited one does.
 */
export function fingerprintOf(root: string): BuildFingerprint {
  const base = resolve(root);
  const problems: string[] = [];
  const entries: Array<[string, string]> = [];
  for (const entry of IMAGE_INPUTS) entries.push(...filesUnder(base, entry, problems));

  const shape = (digest: string | null): BuildFingerprint => ({
    digest,
    files: entries.length,
    root: base,
    inputs: [...IMAGE_INPUTS],
    problems,
  });

  if (problems.length > 0) return shape(null);

  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const hash = createHash(DIGEST_ALGORITHM);
  for (const [rel, path] of entries) {
    let fileDigest: string;
    try {
      fileDigest = createHash(DIGEST_ALGORITHM).update(readFileSync(path)).digest('hex');
    } catch (error) {
      problems.push(`${rel} unreadable: ${error instanceof Error ? error.message : String(error)}`);
      return shape(null);
    }
    hash.update(Buffer.from(rel, 'utf8'));
    hash.update(Buffer.from([0]));
    hash.update(Buffer.from(fileDigest, 'ascii'));
    hash.update(Buffer.from([0]));
  }
  return shape(`${DIGEST_ALGORITHM}:${hash.digest('hex')}`);
}

/**
 * `fingerprintOf(workspaceRoot())` — what this running process was built from.
 *
 * Computed per call rather than cached at import. The tree it reads is an image layer and does not
 * move, so a cache would be safe; it is not worth the staleness question next to a `/health` that
 * already awaits six network probes.
 */
export function buildFingerprint(): BuildFingerprint {
  return fingerprintOf(workspaceRoot());
}

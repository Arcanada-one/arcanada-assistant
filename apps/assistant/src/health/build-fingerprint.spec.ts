// A2-222 — the digest the deploy gate rests on, and the ways it is allowed to have no value.
//
// The point of these tests is not that a hash function hashes. It is that this particular digest
// discriminates the two cases the old `arcanada-compose-broker arcanada-assistant freshness` check
// conflated: a commit that changes the image (must change the digest) and a commit that does not
// (must not). Plus the two hazards specific to THIS image, which is single-stage and builds in
// place inside the very directories being hashed:
//
//   * `pnpm install` and `pnpm build` write `node_modules/`, `dist/` and `.tsbuildinfo` INSIDE
//     `apps/assistant` and `packages/core`, so the container carries files a fresh CI checkout
//     has never seen — if any moved the digest, every deploy would be red;
//   * the digest is computed by two implementations in two languages (this module in the
//     container, `scripts/ci/deployed-build-gate.py` on the deploy runner), so both are run over
//     the same trees here and compared.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  IGNORED_DIR_NAMES,
  IMAGE_INPUTS,
  fingerprintOf,
  isIgnored,
  workspaceRoot,
} from './build-fingerprint.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOCKERFILE = join(REPO_ROOT, 'apps', 'assistant', 'Dockerfile');
const GATE = join(REPO_ROOT, 'scripts', 'ci', 'deployed-build-gate.py');

const temporaries: string[] = [];
afterEach(() => {
  while (temporaries.length > 0)
    rmSync(temporaries.pop() as string, { recursive: true, force: true });
});

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'assistant-fingerprint-'));
  temporaries.push(root);
  return root;
}

/** A minimal stand-in for the build context: every declared image input, nothing else. */
function tree(options: { src?: string; dockerfile?: string } = {}): string {
  const root = temporary();
  mkdirSync(join(root, 'apps', 'assistant', 'src'), { recursive: true });
  mkdirSync(join(root, 'packages', 'core', 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"arcanada-assistant"}\n');
  writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n");
  writeFileSync(join(root, 'tsconfig.base.json'), '{}\n');
  writeFileSync(join(root, 'tsconfig.json'), '{}\n');
  writeFileSync(join(root, 'apps', 'assistant', 'package.json'), '{"name":"assistant"}\n');
  writeFileSync(
    join(root, 'apps', 'assistant', 'src', 'main.ts'),
    options.src ?? 'export const x = 1;\n',
  );
  writeFileSync(
    join(root, 'apps', 'assistant', 'Dockerfile'),
    options.dockerfile ?? 'FROM node:24-alpine\n',
  );
  writeFileSync(join(root, 'packages', 'core', 'package.json'), '{"name":"@arcanada/core"}\n');
  writeFileSync(join(root, 'packages', 'core', 'src', 'index.ts'), 'export const core = 1;\n');
  return root;
}

/** The Python implementation the deploy runner uses, over the same tree. Exit 1 means "no
 * digest", which is a verdict here, not a crash — the JSON is on stdout either way. */
function pythonFingerprint(root: string): { digest: string | null; problems: string[] } {
  try {
    return JSON.parse(
      execFileSync('python3', [GATE, '--print-fingerprint', '--root', root], { encoding: 'utf8' }),
    );
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    if (failure.status === 1 && failure.stdout) return JSON.parse(failure.stdout);
    throw error;
  }
}

describe('the digest', () => {
  it('is stable across calls and shaped sha256:<64 hex>', () => {
    const root = tree();
    expect(fingerprintOf(root).digest).toBe(fingerprintOf(root).digest);
    expect(fingerprintOf(root).digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('moves when a source byte moves — the case the gate must catch', () => {
    // An image input changed, so a container that was not recreated onto the new image is running
    // something else and the deploy has not landed.
    expect(fingerprintOf(tree({ src: 'export const x = 2;\n' })).digest).not.toBe(
      fingerprintOf(tree()).digest,
    );
  });

  it('moves when the Dockerfile moves, with no special handling', () => {
    // apps/assistant/Dockerfile lives INSIDE a declared input, so `COPY apps/assistant` already
    // puts it in the image and this digest already covers it. A commit that changes only the CMD
    // builds a new image AND moves the digest, so a container never recreated onto it cannot pass
    // — a false green in a deploy gate is worse than the false red being replaced. argana had to
    // copy its Dockerfile into the image on purpose to get this; here the layout gives it free,
    // and this test is what keeps it true if the file ever moves out.
    const changed = tree({ dockerfile: 'FROM node:24-alpine\nCMD ["node","dist/main.js"]\n' });
    expect(fingerprintOf(changed).digest).not.toBe(fingerprintOf(tree()).digest);
  });

  it('moves when a file is renamed with identical content', () => {
    const root = tree();
    const before = fingerprintOf(root).digest;
    renameSync(
      join(root, 'packages', 'core', 'src', 'index.ts'),
      join(root, 'packages', 'core', 'src', 'i.ts'),
    );
    expect(fingerprintOf(root).digest).not.toBe(before);
  });

  it('moves when a new source file appears', () => {
    const root = tree();
    const before = fingerprintOf(root).digest;
    writeFileSync(join(root, 'apps', 'assistant', 'src', 'new.ts'), 'export const n = 1;\n');
    expect(fingerprintOf(root).digest).not.toBe(before);
  });

  it('does NOT move for docs, workflows or ops files — the false red, as a test', () => {
    // This is the whole reason the gate was replaced. None of these reach the image, so a deploy
    // that recreates nothing is a CORRECT deploy and must be green.
    const root = tree();
    const before = fingerprintOf(root).digest;
    writeFileSync(join(root, 'README.md'), '# assistant\n');
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'name: CI\n');
    mkdirSync(join(root, 'ops', 'postgres-init'), { recursive: true });
    writeFileSync(join(root, 'ops', 'postgres-init', '01.sql'), 'SELECT 1;\n');
    expect(fingerprintOf(root).digest).toBe(before);
  });

  it('does NOT move for what the in-place build writes inside the inputs', () => {
    // The hazard unique to this single-stage image. Every path below is INSIDE a declared input,
    // exactly where `pnpm install` and `pnpm build` put their output in the running container and
    // where a fresh CI checkout has nothing. One un-ignored entry here makes every deploy red.
    const root = tree();
    const before = fingerprintOf(root).digest;
    mkdirSync(join(root, 'apps', 'assistant', 'dist'), { recursive: true });
    writeFileSync(join(root, 'apps', 'assistant', 'dist', 'main.js'), 'compiled\n');
    writeFileSync(join(root, 'apps', 'assistant', 'dist', '.tsbuildinfo'), '{}\n');
    mkdirSync(join(root, 'apps', 'assistant', 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(root, 'apps', 'assistant', 'node_modules', '.bin', 'tsc'), '#!/bin/sh\n');
    mkdirSync(join(root, 'packages', 'core', 'dist'), { recursive: true });
    writeFileSync(join(root, 'packages', 'core', 'dist', 'index.js'), 'compiled\n');
    mkdirSync(join(root, 'packages', 'core', 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'packages', 'core', 'node_modules', 'x.js'), 'dep\n');
    mkdirSync(join(root, 'apps', 'assistant', 'coverage'), { recursive: true });
    writeFileSync(join(root, 'apps', 'assistant', 'coverage', 'i.html'), '<html></html>\n');
    writeFileSync(join(root, 'apps', 'assistant', 'stray.tsbuildinfo'), '{}\n');
    writeFileSync(join(root, 'apps', 'assistant', 'debug.log'), 'noise\n');
    writeFileSync(join(root, 'apps', 'assistant', '.DS_Store'), 'junk\n');
    expect(fingerprintOf(root).digest).toBe(before);
  });

  it('is not measured when a declared input is missing', () => {
    // The third verdict. A root that does not carry the declared inputs yields no digest and a
    // reason, never a digest over whatever happened to be there — which is the real case if this
    // module is ever loaded from somewhere that is not the workspace.
    const result = fingerprintOf(temporary());
    expect(result.digest).toBeNull();
    expect(result.problems.some((problem) => problem.includes('apps/assistant'))).toBe(true);
  });

  it('is not measured when a declared input directory is empty', () => {
    const root = tree();
    rmSync(join(root, 'packages', 'core'), { recursive: true, force: true });
    mkdirSync(join(root, 'packages', 'core'), { recursive: true });
    const result = fingerprintOf(root);
    expect(result.digest).toBeNull();
    expect(result.problems.some((problem) => problem.includes('empty directory'))).toBe(true);
  });

  it('judges what to ignore by the path relative to the root, not absolutely', () => {
    // A checkout that happens to live under a directory called `dist` must not fingerprint to
    // nothing. `isIgnored` only ever sees the relative path.
    expect(isIgnored('apps/assistant/src/main.ts')).toBe(false);
    expect(isIgnored('apps/assistant/dist/main.js')).toBe(true);
    expect(isIgnored('packages/core/node_modules/x.js')).toBe(true);
  });
});

describe('this repository', () => {
  it('fingerprints, over more than a handful of files', () => {
    const result = fingerprintOf(REPO_ROOT);
    expect(result.problems).toEqual([]);
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.files).toBeGreaterThan(50);
  });

  it('resolves the workspace root from this module, wherever it is loaded from', () => {
    // `/workspace` in the container and the repository root here — the same walk to
    // pnpm-workspace.yaml resolves both, from apps/assistant/dist/health/ and from
    // apps/assistant/src/health/. An env var would be a setting that could differ between the
    // two sides of a comparison whose whole point is that they cannot.
    expect(workspaceRoot()).toBe(REPO_ROOT);
    expect(workspaceRoot(join(REPO_ROOT, 'apps', 'assistant', 'dist', 'health'))).toBe(REPO_ROOT);
  });

  it('declares image inputs that match the Dockerfile COPY lines', () => {
    // The drift guard. A COPY added to the Dockerfile without a matching entry in IMAGE_INPUTS is
    // a file that reaches the image and never reaches the gate — a silent hole, so it is a red
    // test instead. The Dockerfile copies some paths twice (the package.json files first, for the
    // install layer, then the whole directory), so a token is satisfied by a declared input that
    // CONTAINS it; and every declared input must be named by some COPY, or the gate would be
    // hashing files the image does not have.
    const copied: string[] = [];
    for (const line of readFileSync(DOCKERFILE, 'utf8').split('\n')) {
      const stripped = line.trim();
      if (!stripped.toUpperCase().startsWith('COPY ')) continue;
      const tokens = stripped.split(/\s+/).slice(1);
      if (tokens.some((token) => token.startsWith('--from='))) continue;
      const sources = tokens.filter((token) => !token.startsWith('--'));
      expect(sources.length, `unparsed COPY instruction: ${stripped}`).toBeGreaterThanOrEqual(2);
      for (const source of sources.slice(0, -1))
        copied.push(source.replace(/^\.\//, '').replace(/\/+$/, ''));
    }
    expect(copied.length).toBeGreaterThan(0);
    const covers = (token: string): boolean =>
      IMAGE_INPUTS.some((input) => token === input || token.startsWith(`${input}/`));
    expect(copied.filter((token) => !covers(token))).toEqual([]);
    const named = (input: string): boolean =>
      copied.some((token) => token === input || token.startsWith(`${input}/`));
    expect(IMAGE_INPUTS.filter((input) => !named(input))).toEqual([]);
  });

  it('ignores every directory .dockerignore excludes recursively', () => {
    // The other direction of the same requirement. A recursive `.dockerignore` entry means the
    // build context never carried that directory, so the image cannot have it — and if CI hashed
    // it from its checkout, the two sides would disagree forever. Loosening .dockerignore without
    // loosening IGNORED_DIR_NAMES is therefore a red test.
    const recursive = readFileSync(join(REPO_ROOT, '.dockerignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('**/'))
      .map((line) => line.slice(3));
    expect(recursive.length).toBeGreaterThan(0);
    expect(recursive.filter((name) => !IGNORED_DIR_NAMES.has(name))).toEqual([]);
  });
});

describe('the two implementations of the digest', () => {
  // This module runs inside the container; scripts/ci/deployed-build-gate.py runs on the deploy
  // host, which carries python3 and no guaranteed node. Two languages is a deliberate cost;
  // silent divergence between them is not. A gate whose two sides disagreed would fail every
  // deploy while looking like a deploy fault.
  it('agree on this repository', () => {
    expect(pythonFingerprint(REPO_ROOT).digest).toBe(fingerprintOf(REPO_ROOT).digest);
  });

  it('agree on a synthetic tree, including what each one ignores', () => {
    const root = tree();
    mkdirSync(join(root, 'apps', 'assistant', 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'apps', 'assistant', 'node_modules', 'x.js'), 'dep\n');
    mkdirSync(join(root, 'packages', 'core', 'dist'), { recursive: true });
    writeFileSync(join(root, 'packages', 'core', 'dist', 'i.js'), 'compiled\n');
    writeFileSync(join(root, 'apps', 'assistant', 'x.tsbuildinfo'), '{}\n');
    writeFileSync(join(root, 'apps', 'assistant', '.DS_Store'), 'junk\n');
    const expected = fingerprintOf(root).digest;
    expect(expected).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(pythonFingerprint(root).digest).toBe(expected);
  });

  it('agree that a root without the inputs has no digest', () => {
    const empty = temporary();
    expect(fingerprintOf(empty).digest).toBeNull();
    expect(pythonFingerprint(empty).digest).toBeNull();
  });
});

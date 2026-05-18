import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const assets = ['aal/agent-scopes.yaml', 'approval/agent-approval-policy.yaml'];

for (const rel of assets) {
  const src = join(root, 'src', rel);
  const dst = join(root, 'dist', rel);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst);
  console.log(`[copy-assets] ${rel}`);
}

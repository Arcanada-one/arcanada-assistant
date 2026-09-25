/**
 * A2-374 — the Munera boot gate, as a side-effect module. `main.ts` imports it
 * BEFORE `app.module.js`: ES modules evaluate their imports in order, and
 * app.module's `ConfigModule.forRoot` validates the environment while it is
 * being evaluated. A static import (not `await import`) keeps main → app.module
 * a visible edge for the graph verifier.
 *
 * A refusal exits 78 (EX_CONFIG) with one greppable line instead of exit 1 and a
 * stack from inside Nest. Nothing here touches the network.
 */
import { checkMuneraBoot, formatBootRefusal } from './config/munera-boot-gate.js';

const gate = checkMuneraBoot(process.env);
if (!gate.ok) {
  // eslint-disable-next-line no-console -- pino is not wired before Nest
  console.error(`[bootstrap] ${formatBootRefusal(gate)}`);
  process.exit(gate.exitCode);
}

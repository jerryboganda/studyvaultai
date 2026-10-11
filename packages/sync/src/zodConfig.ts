import { z } from 'zod';

// Same reason as packages/shared/src/zodConfig.ts: Zod's JIT probes `new Function('')`, which a strict
// extension CSP reports as a violation. Idempotent, and it must run before any schema is built, so
// schema.ts imports this module first. The reference server imports schema.ts too and is fine with it.
z.config({ jitless: true });

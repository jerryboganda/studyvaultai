import { z } from 'zod';

// Same reason as packages/shared/src/zodConfig.ts: under the MV3 CSP Zod's `new Function` probe is
// reported as a violation, so parsers are interpreted. Duplicated (not imported) so that @ai stays a
// self-contained pure package; calling z.config twice with the same value is harmless.
z.config({ jitless: true });

import { z } from 'zod';

// Zod probes `new Function('')` to decide whether it may compile parsers; under a strict CSP that
// caught throw is still reported as a violation in every context. Parsers are interpreted instead.
// This must be evaluated before any schema is built (Zod reads the flag at construction), so
// `index.ts` and `schema.ts` import this module first.
z.config({ jitless: true });

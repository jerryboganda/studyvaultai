import type { Scenario } from './kit';

/** Deterministic seeded scenarios, loaded on demand (`?scenario=<id>`). */
export const SCENARIOS: Record<string, () => Promise<Scenario>> = {
  fresh: async () => (await import('./fresh')).fresh,
  student: async () => (await import('./student')).student,
  heavy: async () => (await import('./heavy')).heavy,
  edge: async () => (await import('./edge')).edge,
};

export async function loadScenario(id: string): Promise<Scenario> {
  const load = SCENARIOS[id];
  if (!load) {
    throw new Error(`Unknown scenario "${id}". Known: ${Object.keys(SCENARIOS).join(', ')}.`);
  }
  return load();
}

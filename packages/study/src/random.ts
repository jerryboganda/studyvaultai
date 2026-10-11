/** Source of uniform numbers in [0, 1). Injected wherever the engine needs chance. */
export type Random = () => number;

/** Small seedable PRNG (mulberry32) for deterministic shuffles in tests and replayable sessions. */
export function seededRandom(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates over a copy; never mutates the input. */
export function shuffled<T>(items: readonly T[], random: Random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

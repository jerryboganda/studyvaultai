import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia(QUERY).matches;
}

/** Live prefers-reduced-motion: script-driven motion (confetti, XP float) checks this. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const mq = matchMedia(QUERY);
    const sync = () => setReduced(mq.matches);
    mq.addEventListener?.('change', sync);
    return () => mq.removeEventListener?.('change', sync);
  }, []);
  return reduced;
}

/** Soft tile / status tones shared by picture cards, More tiles and chips. */
export type Tone = 'primary' | 'sun' | 'success' | 'danger' | 'warning' | 'violet' | 'neutral';

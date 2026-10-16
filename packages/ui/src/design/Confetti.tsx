import { useEffect, useRef } from 'react';
import { useReducedMotion } from './motion';

/** The last piece lands before this (0.72 s delay + 3 s fall): one finite burst, < 5 s (WCAG 2.2.2). */
const BURST_MS = 3800;

export type ConfettiProps = {
  pieces?: number;
  /** Called once the burst is over (immediately under reduced motion); unmount it then. */
  onDone?: () => void;
};

/**
 * Decorative celebration: a single burst of falling pieces inside the nearest positioned parent.
 * Hidden from assistive tech, and not rendered at all under prefers-reduced-motion. Mount it with a
 * new key to fire again.
 */
export function Confetti({ pieces = 40, onDone }: ConfettiProps) {
  const reduced = useReducedMotion();
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  useEffect(() => {
    const timer = setTimeout(() => done.current?.(), reduced ? 0 : BURST_MS);
    return () => clearTimeout(timer);
  }, [reduced]);

  if (reduced) return null;
  return (
    <div className="sv-confetti" aria-hidden="true" data-testid="sv-confetti">
      {Array.from({ length: pieces }, (_, i) => (
        <span
          key={i}
          className={`sv-confetti__bit sv-confetti__bit--c${i % 5} sv-confetti__bit--s${i % 3}`}
          style={{
            left: `${(i * 37 + 7) % 100}%`,
            animationDelay: `${(i % 10) * 0.08}s`,
            animationDuration: `${1.8 + (i % 5) * 0.3}s`,
          }}
        />
      ))}
    </div>
  );
}

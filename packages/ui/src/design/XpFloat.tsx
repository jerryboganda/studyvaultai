import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

type Float = { id: number; amount: number };

/**
 * "+2 XP" float (UX_DESIGN 6.14). Place `node` inside a positioned parent next to the XP chip. It is
 * aria-hidden and has no live region of its own: the surface speaks the XP as part of its one
 * polite announcement ("Saved, +2 XP"), never as a separate message. It rises over 1.2 s; under
 * reduced motion it fades in place (opacity only, 1.4 s) and is removed after the same time.
 */
export function useXpFloat(durationMs = 1400): {
  award: (amount: number) => void;
  node: ReactNode;
} {
  const [float, setFloat] = useState<Float | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const award = useCallback(
    (amount: number) => {
      clearTimeout(timer.current);
      // A new id remounts the float, so a second award restarts the animation.
      setFloat((f) => ({ id: (f?.id ?? 0) + 1, amount }));
      timer.current = setTimeout(() => setFloat(null), durationMs);
    },
    [durationMs],
  );

  const node = (
    <span className="sv-xpfloat-anchor" aria-hidden="true">
      {float && (
        <span key={float.id} className="sv-xpfloat">
          +{float.amount} XP
        </span>
      )}
    </span>
  );
  return { award, node };
}

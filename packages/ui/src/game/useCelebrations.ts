import { useCallback, useEffect, useRef, useState } from 'react';
import { claimCelebrations, type GameState } from '@storage';
import type { Celebration } from '@study';

export interface CelebrationQueue {
  /** The celebration to show now, or null. Show one at a time; never steal focus. */
  current: Celebration | null;
  /** How many more are waiting after `current`. */
  queued: number;
  /** The current one was shown (or closed): move to the next. */
  dismiss(): void;
}

const isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

/**
 * Today's celebrations for this page (ADR-022 section 9), each exactly once per device: a pending
 * milestone is claimed in one storage transaction, so of two pages that race only one gets it. A
 * page claims only while it is visible and `enabled` (the review page passes `phase === 'done'`,
 * so nothing interrupts a card; what is queued waits while it is false). Claimed items are queued
 * and handed out one at a time; the host speaks each through the polite live region and drops
 * confetti under reduced motion. Nothing is shown while Game mode is off.
 */
export function useCelebrations(
  state: GameState | undefined,
  o: { enabled?: boolean } = {},
): CelebrationQueue {
  const enabled = o.enabled ?? true;
  const [visible, setVisible] = useState(isVisible);
  const [queue, setQueue] = useState<Celebration[]>([]);
  // A claim is final in storage: its result is queued even when the effect re-ran meanwhile.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const onChange = () => setVisible(isVisible());
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  const pending = state?.ready && state.mode ? state.pending : null;
  const keys = pending?.map((c) => c.key).join('\n') ?? '';
  useEffect(() => {
    if (!pending || pending.length === 0 || !enabled || !visible) return;
    claimCelebrations(pending).then(
      (fresh) => {
        if (mounted.current && fresh.length > 0) setQueue((q) => [...q, ...fresh]);
      },
      (err: unknown) => console.warn('[StudyVault] could not claim celebrations', err),
    );
    // `keys` stands for `pending`: a new state object with the same milestones claims nothing new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, enabled, visible]);

  // Switching Game mode off drops what was waiting: switching it back on brings no backlog.
  const modeOff = state?.mode === false;
  const [wasOff, setWasOff] = useState(modeOff);
  if (modeOff !== wasOff) {
    setWasOff(modeOff);
    if (modeOff) setQueue([]);
  }

  const dismiss = useCallback(() => setQueue((q) => q.slice(1)), []);
  const show = enabled && !modeOff;
  return {
    current: show ? (queue[0] ?? null) : null,
    queued: show ? Math.max(0, queue.length - 1) : 0,
    dismiss,
  };
}

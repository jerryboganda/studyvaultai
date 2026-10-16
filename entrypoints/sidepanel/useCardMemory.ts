import { createContext, useCallback, useContext, useState } from 'react';

/**
 * A card's own UI state (its open drawer, a study note or tag being typed), kept by highlight id
 * above the card lists. The lists unmount whenever the panel follows another tab and comes back
 * (or a card moves between "Needs a look" and "On this page"); a remounted card picks up there.
 */
export const CardMemory = createContext<Map<string, unknown> | null>(null);

/** useState that outlives a remount of the card: kept under `key` in the panel's CardMemory. */
export function useCardMemory<T>(key: string, initial: T): [T, (next: T) => void] {
  const memory = useContext(CardMemory);
  const [value, setValue] = useState<T>(() =>
    memory?.has(key) ? (memory.get(key) as T) : initial,
  );
  const set = useCallback(
    (next: T) => {
      if (Object.is(next, initial)) memory?.delete(key);
      else memory?.set(key, next);
      setValue(next);
    },
    [memory, key, initial],
  );
  return [value, set];
}

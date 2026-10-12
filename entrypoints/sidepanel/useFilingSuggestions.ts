import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { FILING_SUGGESTION_PREFIX, type FilingSuggestion } from '@shared';
import { listFilingSuggestions } from '@storage';
import { useDataEpoch } from '@ui';

/**
 * The filing rules' pending suggestions (docs/adr/017-filing-rules.md), by highlight id. They live
 * in chrome.storage.session, written by the worker after a capture: read when the panel mounts, on
 * every change of that area and after every data change (a highlight filed elsewhere has no
 * suggestion any more). `refresh` re-reads at once, after the panel's own file / dismiss.
 */
export function useFilingSuggestions(): {
  suggestions: ReadonlyMap<string, FilingSuggestion>;
  refresh(): void;
} {
  const epoch = useDataEpoch();
  const [suggestions, setSuggestions] = useState<ReadonlyMap<string, FilingSuggestion>>(
    () => new Map(),
  );
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    listFilingSuggestions().then(
      (list) => {
        if (live) setSuggestions(new Map(list.map((s) => [s.highlightId, s])));
      },
      // A panel without suggestions is a panel as before: nothing to show, nothing to report.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [epoch, tick]);

  useEffect(() => {
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (
        area === 'session' &&
        Object.keys(changes).some((k) => k.startsWith(FILING_SUGGESTION_PREFIX))
      ) {
        setTick((n) => n + 1);
      }
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, []);

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { suggestions, refresh };
}

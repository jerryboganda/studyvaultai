import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useDataEpoch } from '../hooks';
import { SearchHost, type SearchHostPorts, type SearchHostState } from '../vault/searchHost';
import { vaultSearchPorts } from './searchPorts';

export interface SearchHostHandle {
  host: SearchHost;
  state: SearchHostState;
  /** Changes whenever the indexed content changed; a search result is stale when it differs. */
  revision: number;
  /** Open (or build) the index again after an error. */
  retry(): void;
  /** Throw the cache away and read the vault again. */
  rebuild(): void;
}

/**
 * The page's one full-text index (the same `SearchHost` the dashboard uses, backed by the same
 * `meta` cache). Nothing is read until `enabled` is true, so a surface that has not shown search yet
 * pays nothing; afterwards the index follows every change any context makes to the vault.
 */
export function useSearchHost(
  enabled: boolean,
  makePorts: () => SearchHostPorts = vaultSearchPorts,
): SearchHostHandle {
  const [host] = useState(() => new SearchHost(makePorts()));
  const epoch = useDataEpoch();

  useEffect(() => {
    if (!enabled) return undefined;
    void host.start();
    const flush = () => {
      if (document.visibilityState === 'hidden') void host.flush();
    };
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('pagehide', flush);
      host.dispose();
    };
  }, [host, enabled]);

  useEffect(() => {
    if (enabled) host.reconcileSoon();
  }, [host, enabled, epoch]);

  const subscribe = useCallback((cb: () => void) => host.subscribe(cb), [host]);
  const state = useSyncExternalStore(subscribe, () => host.state);
  const revision = useSyncExternalStore(subscribe, () => host.revision);
  const retry = useCallback(() => void host.start(), [host]);
  const rebuild = useCallback(() => void host.rebuild(), [host]);
  return { host, state, revision, retry, rebuild };
}

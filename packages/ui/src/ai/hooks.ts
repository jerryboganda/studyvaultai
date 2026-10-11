import { useAsync, useDataEpoch, useSettings } from '../hooks';
import { useAiEnv } from './context';
import { loadAiConfig } from './runtime';

/**
 * Settings.features.ai. `known` is false until settings have been read: callers must treat that as
 * "off" and not schedule or fetch anything.
 */
export function useAiFlag() {
  const { settings, error, retry, update } = useSettings();
  return {
    known: settings !== null,
    on: settings?.features.ai === true,
    error,
    retry,
    setOn: (next: boolean) => update((s) => ({ ...s, features: { ...s.features, ai: next } })),
  };
}

/** AI settings, key state, endpoint check and today's ledger; re-read after any data change. */
export function useAiConfig(flagOn: boolean) {
  const env = useAiEnv();
  const epoch = useDataEpoch();
  return useAsync(() => loadAiConfig(flagOn, env), [flagOn], [epoch]);
}

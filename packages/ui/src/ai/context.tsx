import { createContext, useContext, type ReactNode } from 'react';
import { defaultAiEnv, type AiEnv } from './runtime';

const AiEnvContext = createContext<AiEnv | null>(null);

/** Supplies the network/clock seam. Production code needs no provider; tests pass a fake provider. */
export function AiEnvProvider({ env, children }: { env: AiEnv; children: ReactNode }) {
  return <AiEnvContext.Provider value={env}>{children}</AiEnvContext.Provider>;
}

export function useAiEnv(): AiEnv {
  return useContext(AiEnvContext) ?? defaultAiEnv();
}

/**
 * @sync: optional synchronisation core. Pure (zod + WebCrypto + injected fetch/clock/storage). Nothing
 * here runs, fetches or schedules unless Settings.features.sync is on: the engine takes an
 * `isEnabled` port and returns immediately when it is false.
 */
export * from './schema.ts';
export * from './json.ts';
export * from './hlc.ts';
export * from './policy.ts';
export { mergeRemote, applyLocalToMeta, freshMeta, isAlive, presentMembers } from './merge.ts';
export type { AppliedChange, MergeInput, MergeOutcome, Row } from './merge.ts';
export * from './ports.ts';
export * from './engine.ts';
export * from './memory.ts';
export * from './transport.ts';
export * from './crypto.ts';
export * from './auth.ts';
export * from './adapters.ts';

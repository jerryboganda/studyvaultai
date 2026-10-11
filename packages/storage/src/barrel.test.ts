// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { activeSyncPolicy, unregisteredTables } from './index';

/**
 * The service worker imports only the package barrel. Backup validation, the integrity check and
 * sync all read the table registry, so importing the barrel alone must leave no table on its
 * placeholder schema (study.ts and ai.ts register theirs at import time; see ADR-010).
 */
describe('the @storage barrel', () => {
  it('registers every table schema on import and syncs every policy table', () => {
    // syncOps is this device's outbox: local-only, validated by its own module, placeholder on purpose
    expect(unregisteredTables()).toEqual(['syncOps']);
    expect(activeSyncPolicy().notSynced).toEqual([]);
  });
});

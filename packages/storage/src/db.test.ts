// @vitest-environment node
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudyVaultError } from '@shared';
import { getDb, resetDbForTests, toStorageError } from './db';
import { listBanks } from './repo';

describe('toStorageError', () => {
  it('passes StudyVaultError through unchanged', () => {
    const err = new StudyVaultError('not_found', 'x');
    expect(toStorageError(err)).toBe(err);
  });

  it('maps quota failures, including when wrapped by Dexie', () => {
    expect(toStorageError(new DOMException('full', 'QuotaExceededError')).code).toBe(
      'quota_exceeded',
    );
    const wrapped = Object.assign(new Error('aborted'), {
      name: 'AbortError',
      inner: new DOMException('full', 'QuotaExceededError'),
    });
    expect(toStorageError(wrapped).code).toBe('quota_exceeded');
  });

  it('maps unusable-database failures to storage_unavailable', () => {
    for (const name of [
      'OpenFailedError',
      'DatabaseClosedError',
      'VersionError',
      'SecurityError',
    ]) {
      expect(toStorageError(Object.assign(new Error('x'), { name })).code).toBe(
        'storage_unavailable',
      );
    }
  });

  it('maps everything else to internal and keeps the message', () => {
    expect(toStorageError(new Error('boom'))).toMatchObject({ code: 'internal', message: 'boom' });
    expect(toStorageError('plain string')).toMatchObject({ code: 'internal' });
  });
});

describe('database opening', () => {
  beforeEach(async () => {
    await resetDbForTests();
  });

  it('surfaces an open failure as storage_unavailable from repo calls', async () => {
    vi.spyOn(getDb(), 'open').mockRejectedValue(new Dexie.OpenFailedError('blocked by browser'));
    await expect(listBanks()).rejects.toMatchObject({
      name: 'StudyVaultError',
      code: 'storage_unavailable',
    });
  });

  it('reuses one lazily created connection', async () => {
    expect(getDb()).toBe(getDb());
    await listBanks();
    expect(getDb().isOpen()).toBe(true);
  });
});

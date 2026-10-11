import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { SearchDocument } from '@shared';
import type { SearchHostPorts } from '../vault/searchHost';
import { useSearchHost } from './useSearchHost';

vi.mock('@storage', () => ({}));

const doc = (id: string, quote: string): SearchDocument => ({
  id,
  docType: 'highlight',
  highlightId: id,
  title: 'Cell biology',
  url: 'https://example.com/cells',
  host: 'example.com',
  quote,
  comment: '',
  headingContext: null,
  tags: [],
  banks: ['Biology'],
  folderPath: [],
  kind: 'essential',
  priority: 3,
  resolveStatus: 'resolved',
  updatedAt: '2026-10-11T10:00:00.000Z',
  deletedAt: null,
});

function ports(docs: SearchDocument[]) {
  const listAll = vi.fn(async () => docs);
  const meta = new Map<string, unknown>();
  const value: SearchHostPorts = {
    listAll,
    listChangedSince: async () => [],
    getLastPurgeAt: async () => null,
    meta: {
      get: async (k) => meta.get(k),
      put: async (k, v) => void meta.set(k, v),
      putMany: async (entries) => {
        for (const e of entries) meta.set(e.key, e.value);
      },
    },
  };
  return { value, listAll };
}

afterEach(cleanup);

describe('useSearchHost', () => {
  it('reads nothing until it is enabled, then builds the index and answers searches', async () => {
    const p = ports([doc('hl-00000001', 'Mitochondria produce ATP.')]);
    const { result, rerender } = renderHook(({ on }) => useSearchHost(on, () => p.value), {
      initialProps: { on: false },
    });
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.host.index).toBeNull();
    expect(p.listAll).not.toHaveBeenCalled();

    rerender({ on: true });
    await waitFor(() => expect(result.current.state.phase).toBe('ready'));
    expect(p.listAll).toHaveBeenCalled();
    const found = result.current.host.search('mitochondria');
    expect(found.total).toBe(1);
    expect(result.current.revision).toBeGreaterThan(0);
  });

  it('reports a failed build as an error that retry can recover from', async () => {
    const p = ports([doc('hl-00000001', 'Mitochondria produce ATP.')]);
    p.listAll.mockRejectedValueOnce(new Error('Disk hiccup'));
    const { result } = renderHook(() => useSearchHost(true, () => p.value));
    await waitFor(() => expect(result.current.state.phase).toBe('error'));
    expect(result.current.state).toMatchObject({ message: 'Disk hiccup' });

    result.current.retry();
    await waitFor(() => expect(result.current.state.phase).toBe('ready'));
  });
});

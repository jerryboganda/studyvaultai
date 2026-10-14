import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { BankLite } from '@shared';
import type { CaptureHost } from '../contract';
import { errorMessage } from './context';

export type BankState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; banks: BankLite[]; lastBankId: string | null };

/** The bank a save goes to: the user's pick, else the last-used bank, else the Inbox, else the first. */
export function pickBank(
  banks: BankLite[],
  lastBankId: string | null,
  current: string | null,
): string | null {
  const keep = (id: string | null): string | null =>
    id !== null && banks.some((b) => b.id === id) ? id : null;
  return (
    keep(current) ?? keep(lastBankId) ?? banks.find((b) => b.isInbox)?.id ?? banks[0]?.id ?? null
  );
}

/**
 * The bank list for one toolbar (its chip and its More options panel share it). Loaded once when the
 * toolbar appears and again when the page window regains focus, so a bank created in the side panel
 * shows up when the user comes back. A refresh that fails keeps the list the user already has.
 */
export function useBanks(host: CaptureHost, anchor: RefObject<HTMLElement | null>) {
  const [state, setState] = useState<BankState>({ status: 'loading' });
  const alive = useRef(true);

  const fetchBanks = useCallback(() => {
    host.listBanks().then(
      (res) => {
        if (alive.current) setState({ status: 'ready', ...res });
      },
      (err: unknown) => {
        if (!alive.current) return;
        setState((prev) =>
          prev.status === 'ready'
            ? prev
            : { status: 'error', message: errorMessage(err, 'Could not load your banks.') },
        );
      },
    );
  }, [host]);

  useEffect(() => {
    alive.current = true;
    fetchBanks();
    const win = anchor.current?.ownerDocument.defaultView;
    win?.addEventListener('focus', fetchBanks);
    return () => {
      alive.current = false;
      win?.removeEventListener('focus', fetchBanks);
    };
  }, [fetchBanks, anchor]);

  const retry = (): void => {
    setState({ status: 'loading' });
    fetchBanks();
  };

  return { state, retry };
}

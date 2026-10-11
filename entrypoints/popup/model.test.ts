import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@shared';
import { siteStatus } from '@ui/testing/fakes';
import { derivePopupState } from './model';

const base = { denyList: defaultSettings().denyList };

describe('derivePopupState', () => {
  it('has no address: unsupported, without needing a status', () => {
    expect(derivePopupState({ ...base, url: undefined, status: null })).toEqual({
      kind: 'unsupported',
      reason: 'no-address',
      scheme: null,
    });
  });

  it('non-http schemes are unsupported and name the scheme', () => {
    const state = derivePopupState({ ...base, url: 'file:///C:/notes.html', status: null });
    expect(state).toEqual({ kind: 'unsupported', reason: 'scheme', scheme: 'file:' });
  });

  it('waits for the worker answer for ordinary pages', () => {
    expect(derivePopupState({ ...base, url: 'https://example.com/a', status: null })).toEqual({
      kind: 'loading',
    });
  });

  it('flags the built-in PDF viewer', () => {
    const state = derivePopupState({
      ...base,
      url: 'https://example.com/papers/cell.PDF',
      status: siteStatus(),
    });
    expect(state).toMatchObject({ kind: 'unsupported', reason: 'pdf' });
  });

  it('denied: reports which deny entries cover the host', () => {
    const state = derivePopupState({
      ...base,
      url: 'https://www.paypal.com/signin',
      status: siteStatus({ denied: true }),
    });
    expect(state).toEqual({ kind: 'denied', host: 'www.paypal.com', entries: ['paypal.com'] });
  });

  it('inactive vs active follows the content script, persistent follows access', () => {
    const url = 'https://example.com/a';
    expect(derivePopupState({ ...base, url, status: siteStatus() })).toEqual({
      kind: 'inactive',
      host: 'example.com',
      pattern: 'https://example.com/*',
      allSites: false,
    });
    expect(
      derivePopupState({
        ...base,
        url,
        status: siteStatus({ active: true, access: 'persistent' }),
      }),
    ).toMatchObject({ kind: 'active', persistent: true });
    expect(derivePopupState({ ...base, url, status: siteStatus({ active: true }) })).toMatchObject({
      kind: 'active',
      persistent: false,
    });
  });

  it('takes all-sites access from the worker, which asked Chrome, not from a stored list', () => {
    const url = 'https://example.com/a';
    expect(
      derivePopupState({ ...base, url, status: siteStatus({ allSites: true }) }),
    ).toMatchObject({ kind: 'inactive', allSites: true });
    expect(
      derivePopupState({ ...base, url, status: siteStatus({ allSites: true, active: true }) }),
    ).toMatchObject({ kind: 'active', allSites: true });
    // Chrome revoked the grant: the worker says false even if Settings still lists the patterns.
    expect(
      derivePopupState({ ...base, url, status: siteStatus({ allSites: false, active: true }) }),
    ).toMatchObject({ kind: 'active', allSites: false });
  });
});

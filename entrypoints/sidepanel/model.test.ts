import { describe, expect, it } from 'vitest';
import { defaultSettings, type PageStatus } from '@shared';
import { makeItem } from '@ui/testing/fakes';
import { derivePageState, groupPageItems, revealAvailability } from './model';

const status: PageStatus = {
  url: 'https://example.com/notes',
  canonicalUrl: 'https://example.com/canonical',
  title: 'Notes',
  counts: { total: 1, resolved: 1, changed: 0, ambiguous: 0, orphaned: 0, pending: 0 },
  paintingSupported: true,
  hasSelection: false,
  blocked: null,
};
const denyList = defaultSettings().denyList;
const tab = { url: 'https://example.com/notes', title: 'Notes tab' };

describe('derivePageState', () => {
  it('is loading until the tab and status are known', () => {
    const base = { tab, status: null, statusSettled: false, denyList };
    expect(derivePageState({ ...base, tabLoaded: false }).kind).toBe('loading');
    expect(derivePageState({ ...base, tabLoaded: true }).kind).toBe('loading');
    expect(derivePageState({ ...base, tab: null, tabLoaded: true }).kind).toBe('no-tab');
  });

  it('takes the page identity from the content script, including the canonical URL', () => {
    const state = derivePageState({ tabLoaded: true, tab, status, statusSettled: true, denyList });
    expect(state).toMatchObject({
      kind: 'live',
      identity: {
        url: 'https://example.com/notes',
        canonicalUrl: 'https://example.com/canonical',
        host: 'example.com',
      },
    });
  });

  it('without a content script, an http tab is inactive but its address is still usable', () => {
    const state = derivePageState({
      tabLoaded: true,
      tab,
      status: null,
      statusSettled: true,
      denyList,
    });
    expect(state).toEqual({
      kind: 'inactive',
      identity: {
        url: 'https://example.com/notes',
        canonicalUrl: null,
        title: 'Notes tab',
        host: 'example.com',
      },
    });
  });

  it('classifies pages where the panel cannot help', () => {
    const settled = { tabLoaded: true, status: null, statusSettled: true, denyList };
    expect(derivePageState({ ...settled, tab: { url: undefined, title: undefined } })).toEqual({
      kind: 'inactive',
      identity: null,
    });
    expect(derivePageState({ ...settled, tab: { url: 'chrome://settings', title: '' } })).toEqual({
      kind: 'unavailable',
      address: { kind: 'unsupported', scheme: 'chrome:' },
    });
    expect(
      derivePageState({ ...settled, tab: { url: 'https://example.com/a.pdf', title: '' } }),
    ).toEqual({ kind: 'unavailable', address: { kind: 'pdf', host: 'example.com' } });
    expect(
      derivePageState({ ...settled, tab: { url: 'https://mail.google.com/x', title: '' } }),
    ).toMatchObject({ kind: 'unavailable', address: { kind: 'denied', host: 'mail.google.com' } });
  });
});

describe('groupPageItems', () => {
  it('puts ambiguous and orphaned first, each group in reading order', () => {
    const resolved2 = makeItem({ start: 50, highlight: { resolveStatus: 'resolved' } });
    const orphaned = makeItem({ start: 90, highlight: { resolveStatus: 'orphaned' } });
    const resolved1 = makeItem({ start: 10, highlight: { resolveStatus: 'changed' } });
    const ambiguous = makeItem({ start: 30, highlight: { resolveStatus: 'ambiguous' } });
    const { attention, rest } = groupPageItems([resolved2, orphaned, resolved1, ambiguous]);
    expect(attention.map((i) => i.highlight.id)).toEqual([
      ambiguous.highlight.id,
      orphaned.highlight.id,
    ]);
    expect(rest.map((i) => i.highlight.id)).toEqual([
      resolved1.highlight.id,
      resolved2.highlight.id,
    ]);
  });

  it('does not mutate its input', () => {
    const a = makeItem({ start: 20 });
    const b = makeItem({ start: 5 });
    const input = [a, b];
    groupPageItems(input);
    expect(input).toEqual([a, b]);
  });
});

describe('revealAvailability', () => {
  it('is enabled only for highlights of the live active page and says why otherwise', () => {
    expect(revealAvailability({ live: true, onActivePage: true })).toEqual({ enabled: true });
    expect(revealAvailability({ live: false, onActivePage: true })).toMatchObject({
      enabled: false,
      reason: expect.stringContaining('not running'),
    });
    expect(revealAvailability({ live: true, onActivePage: false })).toMatchObject({
      enabled: false,
      reason: expect.stringContaining('another page'),
    });
  });
});

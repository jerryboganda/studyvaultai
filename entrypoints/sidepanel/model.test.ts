import { describe, expect, it } from 'vitest';
import { defaultSettings, type PageStatus } from '@shared';
import { makeItem } from '@ui/testing/fakes';
import {
  derivePageState,
  groupPageItems,
  parseTagInput,
  revealAvailability,
  scopeLabel,
  sourceLinkFor,
  tabOf,
  validateBankName,
  validateNoteBody,
  viewFromHash,
} from './model';

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

describe('validateBankName', () => {
  it('accepts a trimmed name up to the limit', () => {
    expect(validateBankName('  Cardiology ')).toBeNull();
    expect(validateBankName('x'.repeat(80))).toBeNull();
  });

  it('explains an empty or over-long name', () => {
    expect(validateBankName('')).toBe('Enter a name for the bank.');
    expect(validateBankName(' \t ')).toBe('Enter a name for the bank.');
    expect(validateBankName('x'.repeat(81))).toMatch(/80 characters or fewer \(this is 81\)/);
  });
});

describe('viewFromHash', () => {
  it('maps the address hash to a tab and ignores anything else', () => {
    expect(viewFromHash('#search')).toBe('search');
    expect(viewFromHash('review')).toBe('review');
    expect(viewFromHash('#page')).toBe('page');
    expect(viewFromHash('')).toBeNull();
    expect(viewFromHash('#inbox')).toBeNull();
    expect(viewFromHash('#__proto__')).toBeNull();
    // Recent moved under More but keeps its deep link.
    expect(viewFromHash('#recent')).toBe('recent');
    expect(viewFromHash('#more')).toBe('more');
  });

  it('selects the More tab while Recent is shown', () => {
    expect(tabOf('recent')).toBe('more');
    expect(tabOf('more')).toBe('more');
    expect(tabOf('banks')).toBe('banks');
  });
});

describe('scopeLabel', () => {
  it('names the bank, and the folder inside it when there is one', () => {
    const bank = { bankId: 'b', bankName: 'Biology', folderId: null, folderName: null };
    expect(scopeLabel(bank)).toBe('Biology');
    expect(scopeLabel({ ...bank, folderId: 'f', folderName: 'Cell' })).toBe('Biology \u203a Cell');
  });
});

describe('source links', () => {
  it('links a web source, hides a placeholder and refuses a script address', () => {
    const web = makeItem({ source: { originalUrl: 'https://example.com/notes' } });
    expect(sourceLinkFor(web)).toEqual({ kind: 'web', href: 'https://example.com/notes' });
    const fake = makeItem({ source: { originalUrl: 'https://studyvault.invalid/imported/9' } });
    expect(sourceLinkFor(fake)).toEqual({ kind: 'none' });
    const evil = makeItem({ source: { originalUrl: 'javascript:alert(1)' as never } });
    expect(sourceLinkFor(evil)).toEqual({ kind: 'none' });
  });

  it('opens a PDF source in the extension reader at the highlight page', () => {
    const base = makeItem();
    const pdf = {
      ...base,
      highlight: {
        ...base.highlight,
        anchorSet: { ...base.highlight.anchorSet, type: 'pdf', pageNumber: 7 } as never,
      },
      source: {
        ...base.source,
        type: 'pdf' as const,
        documentId: 'doc-00000001',
        originalUrl: 'https://studyvault.invalid/pdf/doc-00000001',
      },
    };
    const link = sourceLinkFor(pdf);
    expect(link).toMatchObject({ kind: 'pdf', label: 'Open in the PDF reader, page 7' });
    const params = new URLSearchParams((link as { path: string }).path.split('?')[1]);
    expect(params.get('doc')).toBe('doc-00000001');
    expect(params.get('page')).toBe('7');
    expect(params.get('highlight')).toBe(base.highlight.id);
    expect(sourceLinkFor({ ...pdf, source: { ...pdf.source, documentId: undefined } })).toEqual({
      kind: 'none',
    });
  });
});

describe('parseTagInput', () => {
  it('trims and collapses spacing, and explains an empty or over-long name', () => {
    expect(parseTagInput('  exam   pearl ')).toEqual({ name: 'exam pearl' });
    expect(parseTagInput('   ')).toEqual({ error: 'Enter a tag name.' });
    expect(parseTagInput('x'.repeat(51))).toEqual({
      error: expect.stringMatching(/50 characters or fewer \(this is 51\)/),
    });
    expect(parseTagInput('x'.repeat(50))).toEqual({ name: 'x'.repeat(50) });
  });
});

describe('validateNoteBody', () => {
  it('needs some text and respects the stored limit', () => {
    expect(validateNoteBody('**x**')).toBeNull();
    expect(validateNoteBody(' \n ')).toBe('Write something, or cancel.');
    expect(validateNoteBody('x'.repeat(100_001))).toMatch(/100,000 characters or fewer/);
  });
});

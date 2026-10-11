// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type CaptureResult, type FilingOutcome } from '@shared';

/**
 * The reader's store asks the filing rules about a NEW highlight only (docs/adr/017-filing-rules.md):
 * a rule that names PDF document decides in storage (`decideFiling`), this adapter only builds the
 * candidate and never lets a failure there turn a saved highlight into an error.
 */

const mocks = vi.hoisted(() => ({
  savePdfHighlight: vi.fn(),
  getDocument: vi.fn(),
  filingAfterCapture: vi.fn(),
  acceptFiling: vi.fn(),
  dismissFiling: vi.fn(),
  undoFiling: vi.fn(),
  getTrustedSettings: vi.fn(),
}));

vi.mock('@runtime', () => ({ getTrustedSettings: mocks.getTrustedSettings }));
vi.mock('@storage', () => ({
  acceptFiling: mocks.acceptFiling,
  assertPdfWriteAllowed: vi.fn(),
  cacheDocumentBytes: vi.fn(),
  createBank: vi.fn(),
  dismissFiling: mocks.dismissFiling,
  filingAfterCapture: mocks.filingAfterCapture,
  getDocument: mocks.getDocument,
  getDocumentBytes: vi.fn(),
  getOcrPages: vi.fn(),
  listBanks: vi.fn(),
  listDocuments: vi.fn(),
  listPdfHighlights: vi.fn(),
  removeDocumentBytes: vi.fn(),
  restoreHighlight: vi.fn(),
  saveOcrPage: vi.fn(),
  savePdfHighlight: mocks.savePdfHighlight,
  softDeleteHighlight: vi.fn(),
  undoFiling: mocks.undoFiling,
  updateHighlight: vi.fn(),
  upsertDocument: vi.fn(),
}));

import { createStorageStore } from './store';

const saved = (status: CaptureResult['status']): CaptureResult => ({
  status,
  highlight: {
    id: 'hl-pdf00001',
    sourceId: 'src-00000001',
    exactQuote: 'Beta blockers reduce mortality.',
    anchorSet: {} as CaptureResult['highlight']['anchorSet'],
    kind: 'formula',
    color: 'blue',
    priority: 3,
    userComment: '',
    headingContext: null,
    bankIds: ['inbox-default'],
    capturedAt: '2026-10-11T10:00:00.000Z',
    resolveStatus: 'resolved',
    resolveConfidence: 1,
  },
  bank: { id: 'inbox-default', name: 'Inbox', color: 'blue', isInbox: true },
  addedToBank: true,
});

const input = {
  documentId: 'doc-fingerprint',
  anchorSet: {} as never,
  exactQuote: 'Beta blockers reduce mortality.',
  kind: 'formula',
  color: 'blue',
  bankId: null,
  folderId: null,
  userComment: '',
  priority: 3,
  captureMethod: 'toolbar',
} as const;

const suggested: FilingOutcome = {
  status: 'suggested',
  ruleName: 'Textbooks',
  bank: { id: 'bank-bio00001', name: 'Biology', color: 'green', isInbox: false },
  folderName: null,
  addedTags: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  mocks.getTrustedSettings.mockResolvedValue({ ...defaultSettings(), lastBankId: 'bank-last0001' });
  mocks.getDocument.mockResolvedValue({
    id: 'doc-fingerprint',
    title: 'Pharmacology textbook',
    originalUrl: 'https://books.example.com/pharm.pdf',
  });
});

describe('createStorageStore().savePdfHighlight', () => {
  it('asks about a new highlight as a PDF candidate and returns the answer', async () => {
    mocks.savePdfHighlight.mockResolvedValue(saved('created'));
    mocks.filingAfterCapture.mockResolvedValue(suggested);

    const result = await createStorageStore().savePdfHighlight(input);

    expect(result.filing).toEqual(suggested);
    expect(mocks.filingAfterCapture).toHaveBeenCalledWith({
      highlightId: 'hl-pdf00001',
      placed: { bankId: 'inbox-default', folderId: null },
      requestedBankId: null,
      lastBankId: 'bank-last0001',
      candidate: {
        url: 'https://books.example.com/pharm.pdf',
        title: 'Pharmacology textbook',
        quote: 'Beta blockers reduce mortality.',
        kind: 'formula',
        tagIds: [],
        sourceType: 'pdf',
      },
    });
  });

  it('a local file has no address, and the rules still see its title', async () => {
    mocks.savePdfHighlight.mockResolvedValue(saved('created'));
    mocks.getDocument.mockResolvedValue({ id: 'doc', title: 'Notes.pdf', originalUrl: null });
    mocks.filingAfterCapture.mockResolvedValue(null);
    const result = await createStorageStore().savePdfHighlight(input);
    expect(result).not.toHaveProperty('filing');
    expect(mocks.filingAfterCapture.mock.calls[0]![0].candidate).toMatchObject({
      url: null,
      title: 'Notes.pdf',
    });
  });

  it.each(['duplicate', 'restored'] as const)('does not ask for a %s highlight', async (status) => {
    mocks.savePdfHighlight.mockResolvedValue(saved(status));
    await createStorageStore().savePdfHighlight(input);
    expect(mocks.filingAfterCapture).not.toHaveBeenCalled();
  });

  it('does not ask while "Use filing rules" is off', async () => {
    mocks.savePdfHighlight.mockResolvedValue(saved('created'));
    mocks.getTrustedSettings.mockResolvedValue({ ...defaultSettings(), useFilingRules: false });
    await createStorageStore().savePdfHighlight(input);
    expect(mocks.filingAfterCapture).not.toHaveBeenCalled();
  });

  it('a failure while asking never fails the save', async () => {
    mocks.savePdfHighlight.mockResolvedValue(saved('created'));
    mocks.getTrustedSettings.mockRejectedValue(new Error('settings unreadable'));
    const result = await createStorageStore().savePdfHighlight(input);
    expect(result.status).toBe('created');
    expect(result).not.toHaveProperty('filing');
  });

  it('exposes accept, dismiss and undo of the same storage functions', async () => {
    const store = createStorageStore();
    await store.filing!.accept('hl-pdf00001');
    await store.filing!.dismiss('hl-pdf00001');
    await store.filing!.undo('hl-pdf00001');
    expect(mocks.acceptFiling).toHaveBeenCalledWith('hl-pdf00001');
    expect(mocks.dismissFiling).toHaveBeenCalledWith('hl-pdf00001');
    expect(mocks.undoFiling).toHaveBeenCalledWith('hl-pdf00001');
  });
});

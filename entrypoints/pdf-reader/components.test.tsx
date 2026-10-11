import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BankLite, HighlightPatch, HighlightView } from '@shared';
import type { PagePart, PdfResolution } from '@pdf';
import { Companion } from './Companion';
import { OpenPanel, type WebState } from './OpenPanel';
import { PasswordDialog } from './PasswordDialog';
import { SaveBar } from './SaveBar';
import { Toolbar, type SearchState } from './Toolbar';
import { pdfRows, type PdfSelection } from './model';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const INBOX: BankLite = { id: 'inbox-default', name: 'Inbox', color: 'blue', isInbox: true };
const BIO: BankLite = { id: 'bank-bio00001', name: 'Biology', color: 'green', isInbox: false };

// ---------------------------------------------------------------------------------------------
// Open panel
// ---------------------------------------------------------------------------------------------
describe('OpenPanel', () => {
  const base = {
    fileError: null,
    notice: null,
    onFile: vi.fn(),
    onAllowAndOpen: vi.fn(),
    fileInputRef: createRef<HTMLInputElement>(),
  };
  const src = {
    ok: true as const,
    url: 'https://files.example.org/a/b.pdf',
    origin: 'https://files.example.org',
    pattern: 'https://files.example.org/*',
    host: 'files.example.org',
  };

  it('explains the single-origin permission before asking, and asks on click', async () => {
    const onAllowAndOpen = vi.fn();
    render(
      <OpenPanel
        {...base}
        src={src}
        web={{ t: 'need-permission' }}
        onAllowAndOpen={onAllowAndOpen}
      />,
    );
    expect(screen.getByText(/needs your permission to contact/)).toBeTruthy();
    expect(screen.getByText(/does not send your cookies or sign-ins/)).toBeTruthy();
    await userEvent.click(
      screen.getByRole('button', { name: /Allow access to files\.example\.org and open/ }),
    );
    expect(onAllowAndOpen).toHaveBeenCalledTimes(1);
  });

  it('a declined permission leaves the manual file fallback in view', () => {
    render(<OpenPanel {...base} src={src} web={{ t: 'denied' }} />);
    expect(screen.getByText('Access was not granted')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose a PDF file' })).toBeTruthy();
  });

  const failed = (kind: 'sign-in' | 'network' | 'not-pdf'): WebState => ({
    t: 'failed',
    failure: { kind, message: `failure: ${kind}` },
  });

  it('a sign-in wall is explained without offering to retry or to bypass it', () => {
    render(<OpenPanel {...base} src={src} web={failed('sign-in')} />);
    expect(screen.getByText('failure: sign-in')).toBeTruthy();
    expect(screen.getByText(/does not use your browser sign-ins/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('a network failure can be retried and always points at the manual upload', async () => {
    const onAllowAndOpen = vi.fn();
    render(
      <OpenPanel {...base} src={src} web={failed('network')} onAllowAndOpen={onAllowAndOpen} />,
    );
    expect(screen.getByText(/choose the file below/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onAllowAndOpen).toHaveBeenCalled();
  });

  it('shows download progress in a status region', () => {
    render(
      <OpenPanel
        {...base}
        src={src}
        web={{ t: 'fetching', loaded: 3 * 1048576, total: 12 * 1048576 }}
      />,
    );
    expect(screen.getByRole('status').textContent).toMatch(/3\.0 MB of 12 MB/);
  });

  it('an invalid address is refused with the reason and no permission button', () => {
    render(
      <OpenPanel
        {...base}
        src={{ ok: false, message: 'Only https addresses can be opened' }}
        web={{ t: 'none' }}
      />,
    );
    expect(screen.getByText(/Only https addresses/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Allow access/ })).toBeNull();
  });

  it('hands a chosen file to the reader', () => {
    const onFile = vi.fn();
    render(<OpenPanel {...base} src={null} web={{ t: 'none' }} onFile={onFile} />);
    const input = screen.getByTestId('pdf-file-input') as HTMLInputElement;
    const file = new File(['%PDF-1.4'], 'a.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFile).toHaveBeenCalledWith(file);
  });
});

// ---------------------------------------------------------------------------------------------
// Save bar
// ---------------------------------------------------------------------------------------------
describe('SaveBar', () => {
  const part = (pageNumber: number, quote: string) => ({
    pageNumber,
    quote,
    start: 0,
    end: quote.length,
    rects: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.02 }],
    part: {} as PagePart,
  });
  const selection = (...pages: Array<[number, string]>): PdfSelection => ({
    parts: pages.map(([n, q]) => part(n, q)),
    bounds: { left: 100, top: 100, right: 300, bottom: 120 },
  });
  const props = (over: Partial<Parameters<typeof SaveBar>[0]> = {}) => ({
    selection: selection([3, 'Glomeruli filter plasma.']),
    banks: [INBOX, BIO],
    defaultKind: 'essential' as const,
    defaultBankId: null,
    barRef: createRef<HTMLDivElement>(),
    onSave: vi.fn(async () => ({ summary: 'Saved 1 highlight to Inbox.' })),
    onCreateBank: vi.fn(async (name: string) => ({ ...BIO, id: 'bank-new00001', name })),
    onDismiss: vi.fn(),
    onEngaged: vi.fn(),
    ...over,
  });

  it('saves with the chosen kind, bank and note', async () => {
    const p = props();
    render(<SaveBar {...p} />);
    expect(screen.getByRole('dialog', { name: 'Save selection from page 3' })).toBeTruthy();
    await userEvent.selectOptions(screen.getByTestId('pdf-save-kind'), 'formula');
    await userEvent.selectOptions(screen.getByTestId('pdf-save-bank'), BIO.id);
    await userEvent.type(screen.getByTestId('pdf-save-note'), 'remember this');
    await userEvent.click(screen.getByTestId('pdf-save'));
    expect(p.onSave).toHaveBeenCalledWith({
      kind: 'formula',
      bankId: BIO.id,
      comment: 'remember this',
    });
    expect((await screen.findByRole('status')).textContent).toContain('Saved 1 highlight');
  });

  it('a selection over several pages says so and offers one highlight per page', () => {
    render(
      <SaveBar
        {...props({ selection: selection([4, 'end of page four'], [5, 'start of page five']) })}
      />,
    );
    expect(screen.getByText('This selection spans more than one page')).toBeTruthy();
    expect(
      screen.getByText(/saves each page's part as its own highlight \(pages 4-5\)/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save 2 highlights' })).toBeTruthy();
  });

  it('creates a bank in the extension origin and selects it', async () => {
    const p = props();
    render(<SaveBar {...p} />);
    await userEvent.click(screen.getByRole('button', { name: 'New bank' }));
    await userEvent.type(screen.getByTestId('pdf-new-bank-name'), 'Pharmacology{Enter}');
    expect(p.onCreateBank).toHaveBeenCalledWith('Pharmacology');
    expect(p.onCreateBank).toHaveBeenCalledTimes(1);
  });

  it('shows a failed save in an alert and keeps the bar open', async () => {
    const p = props({ onSave: vi.fn(async () => Promise.reject(new Error('disk full'))) });
    render(<SaveBar {...p} />);
    await userEvent.click(screen.getByTestId('pdf-save'));
    expect((await screen.findByRole('alert')).textContent).toContain('disk full');
    expect(p.onDismiss).not.toHaveBeenCalled();
  });

  it('a blocked save (private window) is explained and cannot be triggered', async () => {
    const p = props({ blockedReason: 'StudyVault does not save from private windows.' });
    render(<SaveBar {...p} />);
    expect(screen.getByText('Not saved from this window')).toBeTruthy();
    const save = screen.getByTestId('pdf-save');
    expect(save.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(save);
    expect(p.onSave).not.toHaveBeenCalled();
  });

  it('Escape dismisses and the bar reports when focus is inside it', async () => {
    const p = props();
    render(<SaveBar {...p} />);
    screen.getByTestId('pdf-save-note').focus();
    expect(p.onEngaged).toHaveBeenCalledWith(true);
    await userEvent.keyboard('{Escape}');
    expect(p.onDismiss).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// Companion
// ---------------------------------------------------------------------------------------------
describe('Companion', () => {
  const hl = (id: string, page: number, over: Partial<HighlightView> = {}): HighlightView => ({
    id,
    sourceId: 'doc-00000001',
    exactQuote: `Quote ${id}`,
    anchorSet: {
      type: 'pdf',
      textAlgorithm: 'sv-pdf-text-v1',
      documentFingerprint: 'f'.repeat(64),
      pageNumber: page,
      rotation: 0,
      rects: [{ x: 0, y: 0, w: 0.1, h: 0.1 }],
      textQuote: { exact: `Quote ${id}`, prefix: '', suffix: '' },
      textPosition: { start: 0, end: 5 },
      contentSignature: 'abc',
      documentTextLength: 10,
    },
    kind: 'essential',
    color: 'amber',
    priority: 3,
    userComment: '',
    headingContext: null,
    bankIds: [INBOX.id],
    capturedAt: '2026-10-11T10:00:00.000Z',
    resolveStatus: 'unchecked',
    resolveConfidence: null,
    ...over,
  });
  const res = (status: PdfResolution['status']): PdfResolution => ({
    status,
    method: 'quote',
    confidence: 1,
    start: 0,
    end: 5,
    rects: status === 'resolved' ? [{ x: 0, y: 0, w: 0.1, h: 0.1 }] : [],
  });
  const actions = () => ({
    goTo: vi.fn(),
    update: vi.fn(async (_id: string, _patch: HighlightPatch) => undefined),
    remove: vi.fn(async () => undefined),
  });
  const mount = (over: Partial<Parameters<typeof Companion>[0]> = {}) => {
    const a = actions();
    const rows = pdfRows([hl('h-aaaaaaa1', 2), hl('h-bbbbbbb2', 1)]);
    render(
      <Companion
        rows={rows}
        resolutions={
          new Map([
            ['h-aaaaaaa1', res('ambiguous')],
            ['h-bbbbbbb2', res('resolved')],
          ])
        }
        banks={[INBOX, BIO]}
        ocrPages={new Set()}
        originalUrl={null}
        selectedId={null}
        paletteFor={() => 'amber'}
        actions={a}
        {...over}
      />,
    );
    return a;
  };

  it('lists highlights by page with their status and explains the ones that are not painted', () => {
    mount();
    const cards = screen.getAllByTestId('pdf-highlight-card');
    expect(cards.map((c) => within(c).getByTestId('pdf-card-page').textContent)).toEqual([
      'p. 1',
      'p. 2',
    ]);
    expect(within(cards[0]!).getByText('Found on page')).toBeTruthy();
    expect(within(cards[1]!).getByText(/Ambiguous/)).toBeTruthy();
    expect(screen.getByText('1 not painted on the page')).toBeTruthy();
  });

  it('an empty document says how to start', () => {
    mount({ rows: [] });
    expect(screen.getByText('No highlights yet')).toBeTruthy();
  });

  it('marks text that came from OCR as machine output', () => {
    mount({ ocrPages: new Set([1]) });
    expect(screen.getByText('OCR text')).toBeTruthy();
    expect(screen.getByText(/recognised from a scanned image and may contain errors/)).toBeTruthy();
  });

  it('the source link is real for web PDFs and honestly disabled for local files', () => {
    mount();
    const disabled = screen.getAllByRole('button', { name: 'Open page in source' })[0]!;
    expect(disabled.getAttribute('aria-disabled')).toBe('true');
    expect(disabled.getAttribute('title')).toMatch(/opened from a file on this device/);
    cleanup();
    mount({ originalUrl: 'https://example.org/doc.pdf' });
    const link = screen.getAllByRole('link', { name: 'Open page in source' })[0]!;
    expect(link.getAttribute('href')).toBe('https://example.org/doc.pdf#page=1');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('jumps, deletes and re-kinds through the actions', async () => {
    const a = mount();
    const first = screen.getAllByTestId('pdf-highlight-card')[0]!;
    await userEvent.click(within(first).getByRole('button', { name: 'Go to highlight' }));
    expect(a.goTo).toHaveBeenCalledWith('h-bbbbbbb2');
    await userEvent.selectOptions(within(first).getByLabelText('Kind'), 'formula');
    expect(a.update).toHaveBeenCalledWith('h-bbbbbbb2', { kind: 'formula', color: 'amber' });
    await userEvent.click(within(first).getByRole('button', { name: 'Delete' }));
    expect(a.remove).toHaveBeenCalledWith('h-bbbbbbb2');
  });

  it('saves the note after a pause and on blur, and never touches the quote', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const a = mount();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const box = within(screen.getAllByTestId('pdf-highlight-card')[0]!).getByLabelText('Note');
    await user.type(box, 'my words');
    expect(a.update).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(a.update).toHaveBeenCalledWith('h-bbbbbbb2', { userComment: 'my words' });
    expect(a.update.mock.calls.every(([, patch]) => !('exactQuote' in patch))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------------------------
describe('Toolbar', () => {
  const search = (over: Partial<SearchState> = {}): SearchState => ({
    query: '',
    status: 'idle',
    total: 0,
    current: -1,
    pagesDone: 0,
    pageCount: 10,
    truncated: false,
    ...over,
  });
  const mount = (over: Partial<Parameters<typeof Toolbar>[0]> = {}) => {
    const p = {
      page: 1,
      pageCount: 10,
      zoom: { kind: 'fit-width' as const },
      effectiveZoom: 1.2,
      search: search(),
      companionOpen: true,
      sidePaneOpen: false,
      highlightCount: 2,
      pageInput: createRef<HTMLInputElement>(),
      searchInput: createRef<HTMLInputElement>(),
      onGoToPage: vi.fn(),
      onZoom: vi.fn(),
      onRotate: vi.fn(),
      onQuery: vi.fn(),
      onFind: vi.fn(),
      onToggleCompanion: vi.fn(),
      onToggleSidePane: vi.fn(),
      onOpenAnother: vi.fn(),
      ...over,
    };
    render(<Toolbar {...p} />);
    return p;
  };

  it('disables previous page on page 1 with the reason', () => {
    mount();
    const prev = screen.getByRole('button', { name: 'Previous page' });
    expect(prev.getAttribute('aria-disabled')).toBe('true');
    expect(prev.getAttribute('title')).toBe('Already on the first page.');
  });

  it('commits a typed page number clamped to the document', async () => {
    const p = mount();
    const input = screen.getByTestId('pdf-page-input');
    await userEvent.clear(input);
    await userEvent.type(input, '99{Enter}');
    expect(p.onGoToPage).toHaveBeenCalledWith(10);
  });

  it('zoom controls change the mode and step from the effective zoom', async () => {
    const p = mount();
    await userEvent.selectOptions(screen.getByTestId('pdf-zoom'), 'fit-page');
    expect(p.onZoom).toHaveBeenCalledWith({ kind: 'fit-page' });
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(p.onZoom).toHaveBeenLastCalledWith({ kind: 'custom', zoom: 1.25 });
    await userEvent.click(screen.getByRole('button', { name: 'Rotate pages clockwise' }));
    expect(p.onRotate).toHaveBeenCalled();
  });

  it('reports search progress, counts and no-match states in words', () => {
    cleanup();
    mount({ search: search({ query: 'renal', status: 'searching', pagesDone: 4, total: 2 }) });
    expect(screen.getByTestId('pdf-find-count').textContent).toBe(
      'Searching… page 4 of 10, 2 found',
    );
    cleanup();
    mount({ search: search({ query: 'renal', status: 'done', total: 17, current: 2 }) });
    expect(screen.getByTestId('pdf-find-count').textContent).toBe('3 of 17');
    cleanup();
    mount({ search: search({ query: 'zzz', status: 'done', total: 0 }) });
    expect(screen.getByTestId('pdf-find-count').textContent).toBe('No matches');
  });

  it('Enter in the search box steps forward and Shift+Enter backward', async () => {
    const p = mount({ search: search({ query: 'renal', status: 'done', total: 3, current: 0 }) });
    const box = screen.getByTestId('pdf-search');
    await userEvent.click(box);
    await userEvent.keyboard('{Enter}');
    expect(p.onFind).toHaveBeenLastCalledWith(1);
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    expect(p.onFind).toHaveBeenLastCalledWith(-1);
  });
});

// ---------------------------------------------------------------------------------------------
// Password dialog
// ---------------------------------------------------------------------------------------------
describe('PasswordDialog', () => {
  it('hands the password over once and states that it is not stored', async () => {
    const onSubmit = vi.fn();
    render(
      <PasswordDialog
        reason="needed"
        fileLabel="locked.pdf"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/does not store it/)).toBeTruthy();
    await userEvent.type(screen.getByTestId('pdf-password'), 's3cret{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('s3cret');
  });

  it('does not submit an empty password and reports a wrong one', async () => {
    const onSubmit = vi.fn();
    render(
      <PasswordDialog
        reason="incorrect"
        fileLabel="locked.pdf"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('did not open the file');
    await userEvent.click(screen.getByRole('button', { name: 'Open PDF' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('cancel gives up', async () => {
    const onCancel = vi.fn();
    render(
      <PasswordDialog
        reason="needed"
        fileLabel="locked.pdf"
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});

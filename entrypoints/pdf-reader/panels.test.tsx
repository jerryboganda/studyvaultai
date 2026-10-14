import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryPdfStore } from '@pdf/testing/memoryStore';
import type { OutlineEntry } from '@pdf';
import { DocInfo } from './DocInfo';
import { OcrPanel } from './OcrPanel';
import { OpenPanel } from './OpenPanel';
import { SidePane } from './SidePane';
import { StoredCopies } from './StoredCopies';
import { pageOcrFromStored, type PageOcr } from './ocrModel';

afterEach(cleanup);

const recognised = (): PageOcr =>
  pageOcrFromStored({
    pageNumber: 3,
    text: 'Glomeruli filter plasma\nat a steady rate',
    correctedText: null,
    language: 'eng',
    engine: 'tesseract 5.1.1',
    confidence: 0.8,
    words: [
      { text: 'Glomeruli', x: 0.1, y: 0.1, w: 0.16, h: 0.025, confidence: 0.95 },
      { text: 'filter', x: 0.28, y: 0.1, w: 0.1, h: 0.025, confidence: 0.7 },
      { text: 'plasma', x: 0.4, y: 0.1, w: 0.12, h: 0.025, confidence: 0.3 },
      { text: 'at', x: 0.1, y: 0.14, w: 0.04, h: 0.025, confidence: 0.9 },
      { text: 'a', x: 0.16, y: 0.14, w: 0.02, h: 0.025, confidence: 0.9 },
      { text: 'steady', x: 0.2, y: 0.14, w: 0.12, h: 0.025, confidence: 0.9 },
      { text: 'rate', x: 0.34, y: 0.14, w: 0.08, h: 0.025, confidence: 0.9 },
    ],
  });

describe('OcrPanel', () => {
  const base = () => ({
    pageNumber: 3,
    unavailableReason: undefined,
    busy: false,
    onRecognizePage: vi.fn(),
    onSetLine: vi.fn(async () => undefined),
    onRevertLine: vi.fn(async () => undefined),
    onRevertPage: vi.fn(async () => undefined),
  });

  it('offers OCR for a page without text and explains an unavailable engine', async () => {
    const p = base();
    const { rerender } = render(<OcrPanel {...p} state="none" ocr={undefined} />);
    await userEvent.click(screen.getByRole('button', { name: 'Recognise page' }));
    expect(p.onRecognizePage).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/nothing is uploaded/)).toBeTruthy();

    rerender(
      <OcrPanel
        {...p}
        state="none"
        ocr={undefined}
        unavailableReason="Text recognition is not available in this build."
      />,
    );
    const button = screen.getByTestId('pdf-ocr-page');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(button);
    expect(p.onRecognizePage).toHaveBeenCalledTimes(1);
  });

  it('a page with its own text has nothing to recognise', () => {
    render(<OcrPanel {...base()} state="embedded" ocr={undefined} />);
    expect(screen.getByText(/nothing to recognise/)).toBeTruthy();
    expect(screen.queryByTestId('pdf-ocr-page')).toBeNull();
  });

  it('shows machine-recognised text with a legend in words and a text cue on every marked word', () => {
    render(<OcrPanel {...base()} state="ocr" ocr={recognised()} />);
    expect(screen.getByText('Machine-recognised text')).toBeTruthy();
    expect(screen.getByText(/may be wrong/)).toBeTruthy();
    const legend = screen.getByTestId('pdf-ocr-legend').textContent ?? '';
    expect(legend).toContain('High confidence (85% and above)');
    expect(legend).toContain('Medium confidence (60% to 84%)');
    expect(legend).toContain('Low confidence (under 60%)');
    const first = screen.getAllByTestId('pdf-ocr-line-text')[0]!;
    // Colour is never the only cue: the weaker words say so in text for assistive technology.
    expect(first.textContent).toContain('filter (medium confidence)');
    expect(first.textContent).toContain('plasma (low confidence)');
    expect(first.textContent).not.toContain('Glomeruli (');
    expect(screen.getByTestId('pdf-ocr-summary').textContent).toContain('1 low-confidence word');
  });

  it('edits one line, shows the recognised text beside the correction, and reverts it', async () => {
    const p = base();
    const user = userEvent.setup();
    const { rerender } = render(<OcrPanel {...p} state="ocr" ocr={recognised()} />);
    await user.click(screen.getAllByTestId('pdf-ocr-edit')[1]!);
    const input = screen.getByTestId('pdf-ocr-input') as HTMLInputElement;
    expect(input.value).toBe('at a steady rate');
    await user.clear(input);
    await user.type(input, 'at a constant rate{Enter}');
    expect(p.onSetLine).toHaveBeenCalledWith(1, 'at a constant rate');

    const po = recognised();
    po.corrections = { words: {}, lines: { 1: 'at a constant rate' } };
    rerender(<OcrPanel {...p} state="ocr" ocr={po} />);
    const lines = screen
      .getAllByRole('listitem')
      .filter((li) => li.className.includes('sv-ocr-line'));
    expect(within(lines[1]!).getByText('Edited')).toBeTruthy();
    expect(within(lines[1]!).getByTestId('pdf-ocr-recognised').textContent).toContain(
      'at a steady rate',
    );
    await user.click(within(lines[1]!).getByTestId('pdf-ocr-revert-line'));
    expect(p.onRevertLine).toHaveBeenCalledWith(1);
    // Reverting every correction asks first, with Cancel as the safe choice.
    await user.click(screen.getByTestId('pdf-ocr-revert-page'));
    expect(p.onRevertPage).not.toHaveBeenCalled();
    await user.click(
      within(screen.getByRole('dialog', { name: 'Revert all edits?' })).getByRole('button', {
        name: 'Revert all',
      }),
    );
    expect(p.onRevertPage).toHaveBeenCalled();
  });

  it('Revert all is disabled with a reason when there is nothing to revert; a failed save is shown', async () => {
    const p = base();
    p.onSetLine = vi.fn(async () => Promise.reject(new Error('disk full')));
    const user = userEvent.setup();
    render(<OcrPanel {...p} state="ocr" ocr={recognised()} />);
    expect(screen.getByTestId('pdf-ocr-revert-page').getAttribute('aria-disabled')).toBe('true');
    await user.click(screen.getAllByTestId('pdf-ocr-edit')[0]!);
    await user.type(screen.getByTestId('pdf-ocr-input'), '!{Enter}');
    expect((await screen.findByRole('alert')).textContent).toContain('disk full');
    // The typed correction is not lost: the field stays open with it.
    expect((screen.getByTestId('pdf-ocr-input') as HTMLInputElement).value).toBe(
      'Glomeruli filter plasma!',
    );
  });
});

describe('SidePane', () => {
  const nav = {
    links: null,
    onFollowLink: vi.fn(),
  };
  const outline: OutlineEntry[] = [
    { title: '1 Renal physiology', pageNumber: 1, top: null, depth: 0 },
    { title: '1.1 Filtration', pageNumber: 3, top: null, depth: 1 },
    { title: 'Broken', pageNumber: null, top: null, depth: 0 },
  ];
  const doc = { pageCount: 4, getPage: vi.fn(async () => Promise.reject(new Error('no canvas'))) };

  it('lists the outline, marks the section in view and jumps on click', async () => {
    const onGoToPage = vi.fn();
    render(
      <SidePane
        {...nav}
        tab="outline"
        doc={doc as never}
        outline={outline}
        page={3}
        onGoToPage={onGoToPage}
      />,
    );
    const current = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('aria-current') === 'location')!;
    expect(current.textContent).toContain('1.1 Filtration');
    await userEvent.click(screen.getByRole('button', { name: /1 Renal physiology/ }));
    expect(onGoToPage).toHaveBeenCalledWith(1);
    const broken = screen.getByRole('button', { name: /Broken/ });
    expect(broken.getAttribute('aria-disabled')).toBe('true');
    expect(broken.getAttribute('title')).toMatch(/does not point to a page/);
  });

  it('says so when a file has no outline and while it is still being read', async () => {
    const props = {
      ...nav,
      tab: 'outline' as const,
      doc: doc as never,
      page: 1,
      onGoToPage: vi.fn(),
    };
    const { rerender } = render(<SidePane {...props} outline={[]} />);
    expect(screen.getByTestId('pdf-outline-empty').textContent).toMatch(/No outline/);
    rerender(<SidePane {...props} outline={null} />);
    expect(screen.getByRole('status').textContent).toContain('Reading the outline');
  });

  it('the Pages tab has one button per page and navigates', async () => {
    const onGoToPage = vi.fn();
    render(
      <SidePane
        {...nav}
        tab="pages"
        doc={doc as never}
        outline={[]}
        page={2}
        onGoToPage={onGoToPage}
      />,
    );
    const thumbs = screen.getAllByRole('button', { name: /Go to page/ });
    expect(thumbs).toHaveLength(4);
    expect(thumbs[1]!.getAttribute('aria-current')).toBe('page');
    await userEvent.click(thumbs[3]!);
    expect(onGoToPage).toHaveBeenCalledWith(4);
  });
});

describe('DocInfo', () => {
  const props = {
    title: 'Renal physiology',
    pageCount: 12,
    byteLength: 5 * 1048576,
    fingerprint: 'ab'.repeat(32),
    textStatus: 'partial' as const,
    scannedPages: 3,
    ocrPages: 2,
    host: null,
    copy: 'none' as const,
    copyUnavailable: undefined,
    busy: false,
    onKeep: vi.fn(),
    onRemove: vi.fn(),
  };

  it('shows the properties the person asked for', () => {
    render(<DocInfo {...props} />);
    const text = screen.getByTestId('pdf-props').textContent ?? '';
    expect(text).toContain('Renal physiology');
    expect(text).toContain('12');
    expect(text).toContain('5.0 MB');
    expect(text).toContain('abababababab'); // first 12 digits of the fingerprint
    expect(text).not.toContain('ab'.repeat(32));
    expect(screen.getByTestId('pdf-props-text').textContent).toContain('3 pages without text');
    expect(screen.getByTestId('pdf-props-text').textContent).toContain('2 pages recognised by OCR');
    expect(text).toContain('A file on this device');
  });

  it('keeps and removes the stored copy with sizes, and explains when it cannot', async () => {
    const onKeep = vi.fn();
    const onRemove = vi.fn();
    const { rerender } = render(<DocInfo {...props} onKeep={onKeep} onRemove={onRemove} />);
    await userEvent.click(screen.getByTestId('pdf-keep-copy'));
    expect(onKeep).toHaveBeenCalled();
    rerender(
      <DocInfo {...props} copy={{ bytes: 5 * 1048576 }} onKeep={onKeep} onRemove={onRemove} />,
    );
    expect(screen.getByTestId('pdf-props-copy').textContent).toContain('5.0 MB');
    await userEvent.click(screen.getByTestId('pdf-remove-copy'));
    expect(onRemove).toHaveBeenCalled();
    rerender(<DocInfo {...props} copyUnavailable="Private window." />);
    const keep = screen.getByTestId('pdf-keep-copy');
    expect(keep.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(keep);
    expect(onKeep).toHaveBeenCalledTimes(1);
  });
});

describe('DocInfo: the popover', () => {
  it('closes on a click outside it, not on one inside it', async () => {
    render(
      <>
        <button type="button">elsewhere</button>
        <DocInfo
          title="Renal physiology"
          pageCount={1}
          byteLength={10}
          fingerprint={'ab'.repeat(32)}
          textStatus="text"
          scannedPages={0}
          ocrPages={0}
          host={null}
          copy="none"
          copyUnavailable={undefined}
          busy={false}
          onKeep={vi.fn()}
          onRemove={vi.fn()}
        />
      </>,
    );
    const details = screen.getByTestId('pdf-props') as HTMLDetailsElement;
    const summary = details.querySelector('summary')!;
    await userEvent.click(summary);
    expect(details.open).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(details.open).toBe(false);
    // A click inside it (its own buttons) leaves it open.
    await userEvent.click(summary);
    await userEvent.click(screen.getByTestId('pdf-keep-copy'));
    expect(details.open).toBe(true);
  });
});

describe('StoredCopies', () => {
  it('lists kept copies with sizes, opens one and removes one without touching the rest', async () => {
    const store = createMemoryPdfStore();
    await store.upsertDocument({
      id: 'a'.repeat(64),
      title: 'Renal physiology',
      pageCount: 12,
      byteLength: 2 * 1048576,
      originalUrl: null,
      textStatus: 'text',
    });
    await store.cacheDocumentBytes!('a'.repeat(64), new Blob([new Uint8Array(2 * 1048576)]));
    await store.cacheDocumentBytes!('b'.repeat(64), new Blob([new Uint8Array(1048576)]));
    const onOpen = vi.fn();
    render(<StoredCopies store={store} onOpen={onOpen} />);
    const rows = await screen.findAllByTestId('pdf-copy');
    expect(rows).toHaveLength(2);
    expect(screen.getByTestId('pdf-copies-total').textContent).toContain('2 copies');
    // Every row's buttons say which file they act on.
    expect(within(rows[0]!).getByRole('button', { name: 'Open Renal physiology' })).toBeTruthy();
    expect(screen.getByTestId('pdf-copies-total').textContent).toContain('3.0 MB');
    expect(rows[0]!.textContent).toContain('Renal physiology');
    expect(rows[0]!.textContent).toContain('2.0 MB');

    await userEvent.click(within(rows[0]!).getByRole('button', { name: /^Open/ }));
    expect(onOpen).toHaveBeenCalledWith('a'.repeat(64));

    await userEvent.click(within(rows[0]!).getByRole('button', { name: /^Remove copy of/ }));
    await waitFor(() => expect(screen.getAllByTestId('pdf-copy')).toHaveLength(1));
    expect(store.copies.has('a'.repeat(64))).toBe(false);
    expect(store.copies.has('b'.repeat(64))).toBe(true);
    expect(store.documents.has('a'.repeat(64))).toBe(true); // the document row is not a copy
  });

  it('says while it is looking, and offers Retry when the list cannot be read', async () => {
    let fail = true;
    const store = {
      listStoredCopies: vi.fn(async () => {
        if (fail) throw new Error('disk busy');
        return [];
      }),
      removeDocumentBytes: undefined,
    };
    render(<StoredCopies store={store} onOpen={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toContain('Checking for stored copies');
    expect((await screen.findByRole('alert')).textContent).toContain('disk busy');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('pdf-copies-empty')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says there are none, and renders nothing without a listing capability', async () => {
    const store = createMemoryPdfStore();
    render(<StoredCopies store={store} onOpen={vi.fn()} />);
    expect(await screen.findByTestId('pdf-copies-empty')).toBeTruthy();
    cleanup();
    const { container } = render(
      <StoredCopies store={{ removeDocumentBytes: undefined }} onOpen={vi.fn()} />,
    );
    expect(container.textContent).toBe('');
  });
});

describe('OpenPanel additions', () => {
  const base = {
    fileError: null,
    notice: null,
    onFile: vi.fn(),
    onAllowAndOpen: vi.fn(),
    fileInputRef: createRef<HTMLInputElement>(),
    src: null,
    web: { t: 'none' as const },
  };

  it('says Chrome’s built-in viewer is not instrumented and how to get a PDF into the reader', () => {
    render(<OpenPanel {...base} />);
    const note = screen.getByTestId('pdf-builtin-note').textContent ?? '';
    expect(note).toContain('built-in PDF viewer');
    expect(note).toContain('extensions cannot read or mark');
    expect(note).toContain('Open in StudyVault reader');
  });

  it.each([
    ['offline', 'Reconnect and try again', true],
    ['not-pdf', 'download it from there', false],
    ['too-large', 'size the reader opens', false],
    ['not-found', 'Check the address', false],
  ] as const)(
    '%s: a specific next step, and a retry only when one can help',
    (kind, text, retry) => {
      render(
        <OpenPanel
          {...base}
          src={{
            ok: true,
            url: 'https://example.org/a.pdf',
            origin: 'https://example.org',
            pattern: 'https://example.org/*',
            host: 'example.org',
          }}
          web={{ t: 'failed', failure: { kind, message: `failure: ${kind}` } }}
        />,
      );
      expect(screen.getByText(`failure: ${kind}`)).toBeTruthy();
      expect(screen.getByText(new RegExp(text))).toBeTruthy();
      expect(Boolean(screen.queryByRole('button', { name: 'Try again' }))).toBe(retry);
      expect(screen.getByRole('button', { name: 'Choose a PDF' })).toBeTruthy();
    },
  );
});

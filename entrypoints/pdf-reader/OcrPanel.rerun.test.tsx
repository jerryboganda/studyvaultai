import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OcrPanel, type RerunInfo } from './OcrPanel';
import { pageOcrFromStored, type PageOcr } from './ocrModel';

afterEach(cleanup);

const recognised = (over: Partial<PageOcr> = {}): PageOcr => ({
  ...pageOcrFromStored({
    pageNumber: 3,
    text: 'Glomeruli filter plasma\nat a steady rate',
    correctedText: null,
    language: 'eng',
    engine: 'tesseract 5.1.1',
    confidence: 0.8,
    words: [
      { text: 'Glomeruli', x: 0.1, y: 0.1, w: 0.16, h: 0.025, confidence: 0.95 },
      { text: 'filter', x: 0.28, y: 0.1, w: 0.1, h: 0.025, confidence: 0.9 },
      { text: 'plasma', x: 0.4, y: 0.1, w: 0.12, h: 0.025, confidence: 0.9 },
      { text: 'at', x: 0.1, y: 0.14, w: 0.04, h: 0.025, confidence: 0.9 },
      { text: 'a', x: 0.16, y: 0.14, w: 0.02, h: 0.025, confidence: 0.9 },
      { text: 'steady', x: 0.2, y: 0.14, w: 0.12, h: 0.025, confidence: 0.9 },
      { text: 'rate', x: 0.34, y: 0.14, w: 0.08, h: 0.025, confidence: 0.9 },
    ],
  }),
  ...over,
});

const previous = {
  text: 'Glomeruli fllter plasma\nat a steady rate',
  correctedText: null,
  words: [],
  language: 'eng',
  engine: 'tesseract 5.1.1',
  confidence: 0.7,
  replacedAt: '2026-10-11T09:30:00.000Z',
};

/** Renders the panel and waits for the section that is loaded on demand. */
async function show(ui: ReactElement) {
  const out = render(ui);
  await screen.findByTestId('pdf-ocr-rerun');
  return out;
}

function setup(over: Partial<RerunInfo> = {}) {
  const info: RerunInfo = {
    recognisedPages: 4,
    corrected: { pages: 0, lines: 0 },
    withEarlier: 0,
    msPerPage: null,
    sessionOnly: false,
    onRerecognisePage: vi.fn(),
    onRerecogniseAll: vi.fn(),
    onRestore: vi.fn(async () => undefined),
    ...over,
  };
  const props = {
    pageNumber: 3,
    unavailableReason: undefined,
    busy: false,
    onRecognizePage: vi.fn(),
    onSetLine: vi.fn(async () => undefined),
    onRevertLine: vi.fn(async () => undefined),
    onRevertPage: vi.fn(async () => undefined),
    rerun: info,
  };
  return { props, info };
}

describe('OcrPanel: reading the text again', () => {
  it('offers nothing when the reader gives it no way to do it', () => {
    const { props } = setup();
    render(<OcrPanel {...props} rerun={undefined} state="ocr" ocr={recognised()} />);
    expect(screen.queryByTestId('pdf-ocr-rerun-page')).toBeNull();
    expect(screen.queryByTestId('pdf-ocr-rerun-all')).toBeNull();
  });

  it('the page action asks first, says what it costs and what stays, and only then runs', async () => {
    const { props, info } = setup({ msPerPage: 6_000 });
    const user = userEvent.setup();
    await show(<OcrPanel {...props} state="ocr" ocr={recognised()} />);

    const button = screen.getByRole('button', { name: 'Re-recognise this page' });
    await user.click(button);
    expect(info.onRerecognisePage).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog', { name: 'Read page 3 again?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(within(dialog).getByTestId('pdf-ocr-rerun-estimate').textContent).toContain(
      'About 6 seconds for 1 page',
    );
    expect(dialog.textContent).toContain('nothing is uploaded');
    expect(dialog.textContent).toContain('stays until the new reading has succeeded');
    expect(dialog.textContent).toContain('Highlights on this page are looked for again');
    expect(within(dialog).queryByTestId('pdf-ocr-rerun-corrections')).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Re-recognise page 3' }));
    expect(info.onRerecognisePage).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button); // focus goes back to where it was
  });

  it('cancelling the question, with the button or Escape, runs nothing', async () => {
    const { props, info } = setup();
    const user = userEvent.setup();
    await show(<OcrPanel {...props} state="ocr" ocr={recognised()} />);
    await user.click(screen.getByTestId('pdf-ocr-rerun-page'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(screen.getByTestId('pdf-ocr-rerun-all'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(info.onRerecognisePage).not.toHaveBeenCalled();
    expect(info.onRerecogniseAll).not.toHaveBeenCalled();
  });

  it('warns about the corrections of the page and about an earlier reading that will be replaced', async () => {
    const { props } = setup();
    const user = userEvent.setup();
    const po = recognised({ previous });
    po.corrections = { words: {}, lines: { 0: 'Glomeruli filter plasma!' } };
    await show(<OcrPanel {...props} state="ocr" ocr={po} />);
    await user.click(screen.getByTestId('pdf-ocr-rerun-page'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('pdf-ocr-rerun-corrections').textContent).toContain(
      'You corrected 1 line on this page',
    );
    expect(within(dialog).getByTestId('pdf-ocr-rerun-corrections').textContent).toContain(
      'dropped and listed afterwards',
    );
    expect(within(dialog).getByTestId('pdf-ocr-rerun-earlier').textContent).toContain(
      'only one step back is kept',
    );
  });

  it('the whole-document action shows the cost from the page count and the last measured time', async () => {
    const { props, info } = setup({
      recognisedPages: 30,
      msPerPage: 7_000,
      corrected: { pages: 2, lines: 5 },
      withEarlier: 1,
    });
    const user = userEvent.setup();
    await show(<OcrPanel {...props} state="none" ocr={undefined} />);

    expect(screen.getByText('30 pages of this document have recognised text.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Re-recognise all pages' }));
    const dialog = screen.getByRole('dialog', { name: 'Read all 30 recognised pages again?' });
    const estimate = within(dialog).getByTestId('pdf-ocr-rerun-estimate').textContent ?? '';
    expect(estimate).toContain('About 4 minutes for 30 pages');
    expect(estimate).toContain('7 seconds a page, as measured on this device in your last run');
    expect(within(dialog).getByTestId('pdf-ocr-rerun-corrections').textContent).toContain(
      'You corrected 5 lines on 2 pages',
    );
    expect(within(dialog).getByTestId('pdf-ocr-rerun-earlier').textContent).toContain(
      '1 page already keeps an earlier reading',
    );
    expect(dialog.textContent).toContain('You can cancel at any time');

    await user.click(within(dialog).getByRole('button', { name: 'Re-recognise all pages' }));
    expect(info.onRerecogniseAll).toHaveBeenCalledTimes(1);
  });

  it('says when the time is an assumption, and when nothing will be saved', async () => {
    const { props } = setup({ recognisedPages: 1, sessionOnly: true });
    const user = userEvent.setup();
    await show(<OcrPanel {...props} state="ocr" ocr={recognised()} />);
    expect(screen.getByText('1 page of this document has recognised text.')).toBeTruthy();
    await user.click(screen.getByTestId('pdf-ocr-rerun-all'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('pdf-ocr-rerun-estimate').textContent).toContain(
      'an assumed 8 seconds a page, because no page has been timed',
    );
    expect(dialog.textContent).toContain('Nothing is saved in this window');
  });

  it('is disabled with its reason, and while a job runs, and still can be discovered', async () => {
    const { props, info } = setup();
    const user = userEvent.setup();
    const reason = 'Text recognition is not available in this build.';
    const { rerender } = await show(
      <OcrPanel {...props} unavailableReason={reason} state="ocr" ocr={recognised()} />,
    );
    const page = screen.getByTestId('pdf-ocr-rerun-page');
    expect(page.getAttribute('aria-disabled')).toBe('true');
    expect(page.getAttribute('aria-describedby')).toBeTruthy();
    await user.click(page);
    expect(screen.queryByRole('dialog')).toBeNull();

    rerender(<OcrPanel {...props} busy state="ocr" ocr={recognised()} />);
    const all = screen.getByTestId('pdf-ocr-rerun-all');
    expect(all.getAttribute('aria-busy')).toBe('true');
    await user.click(all);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(info.onRerecogniseAll).not.toHaveBeenCalled();
  });

  it('restores the previous reading from its own button and says so in a status line', async () => {
    const { props, info } = setup({ withEarlier: 1 });
    const user = userEvent.setup();
    const po = recognised({ previous });
    await show(<OcrPanel {...props} state="ocr" ocr={po} />);

    const note = screen.getByTestId('pdf-ocr-previous').textContent ?? '';
    expect(note).toContain('An earlier reading of this page is kept');
    expect(note).toContain('the reading you have now is kept in its place');
    await user.click(screen.getByRole('button', { name: 'Restore the previous reading' }));
    expect(info.onRestore).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByTestId('pdf-ocr-restore-status').textContent).toBe(
        'Restored the earlier reading of page 3.',
      ),
    );
    // a polite live region, so the change is announced without moving focus
    expect(screen.getByTestId('pdf-ocr-restore-status').getAttribute('role')).toBe('status');
  });

  it('shows no restore button for a page that was never read again', async () => {
    const { props } = setup();
    await show(<OcrPanel {...props} state="ocr" ocr={recognised()} />);
    expect(screen.queryByTestId('pdf-ocr-restore')).toBeNull();
    expect(screen.queryByTestId('pdf-ocr-previous')).toBeNull();
  });

  it('a restore that fails is shown as an alert and leaves the status line empty', async () => {
    const { props } = setup({
      onRestore: vi.fn(async () => Promise.reject(new Error('disk full'))),
    });
    const user = userEvent.setup();
    await show(<OcrPanel {...props} state="ocr" ocr={recognised({ previous })} />);
    await user.click(screen.getByTestId('pdf-ocr-restore'));
    expect((await screen.findByRole('alert')).textContent).toContain('disk full');
    expect(screen.getByTestId('pdf-ocr-restore-status').textContent).toBe('');
  });

  it('has no section at all when the document has no recognised text and the page has none', () => {
    const { props } = setup({ recognisedPages: 0 });
    render(<OcrPanel {...props} state="none" ocr={undefined} />);
    expect(screen.queryByTestId('pdf-ocr-rerun')).toBeNull();
  });
});

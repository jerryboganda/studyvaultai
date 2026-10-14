import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { parseReaderParams, type PermissionsPort } from '@pdf';
import { createMemoryPdfStore } from '@pdf/testing/memoryStore';
import { INCOGNITO_CAPTURE_REFUSAL } from '@shared';
import { openSession } from './loader';
import { UNKNOWN_WINDOW_REFUSAL, type WindowPrivacy } from './privacy';
import { Reader } from './Reader';

// pdf.js is not what is under test here: the reader's decisions are. A chosen file reaches
// `openSession` with the bytes that `readLocalFile` returns (jsdom's File has no stream()).
vi.mock('./loader', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openSession: vi.fn(),
  readLocalFile: vi.fn(async () => ({ ok: true, bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) })),
}));

const A = 'https://files.example.org/*';
const B = 'https://cdn.example.net/*';
const SRC = 'https://files.example.org/a.pdf';

const permissions = browser.permissions as unknown as PermissionsPort;

function paramsFor(src: string | null) {
  return parseReaderParams(src ? `?src=${encodeURIComponent(src)}` : '');
}

function mount(opts: { privacy?: WindowPrivacy; src?: string } = {}) {
  const store = createMemoryPdfStore();
  const ask = vi.fn(async () => opts.privacy ?? 'normal');
  render(
    <Reader store={store} ocr={undefined} params={paramsFor(opts.src ?? null)} privacy={ask} />,
  );
  return { store };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function setSettings(patch: Record<string, unknown>): Promise<void> {
  await fakeBrowser.storage.local.set({ settings: { schemaVersion: 1, ...patch } });
}

/** Choose a file through the open screen's own input. */
async function chooseFile(): Promise<void> {
  const input = await screen.findByTestId('pdf-file-input');
  const file = new File(['%PDF-1.7'], 'notes.pdf', { type: 'application/pdf' });
  fireEvent.change(input, { target: { files: [file] } });
}

function pdf(url: string, over: { status?: number; type?: string } = {}): Response {
  const res = new Response(over.status === 404 ? 'gone' : '%PDF-1.7 x', {
    status: over.status ?? 200,
    headers: { 'content-type': over.type ?? 'application/pdf' },
  });
  Object.defineProperty(res, 'url', { value: url });
  Object.defineProperty(res, 'redirected', { value: url !== SRC });
  return res;
}

beforeEach(() => {
  fakeBrowser.reset();
  vi.mocked(openSession).mockReset();
  vi.mocked(openSession).mockRejectedValue(new Error('stop after open'));
  vi.spyOn(browser.runtime, 'getManifest').mockReturnValue({
    manifest_version: 3,
    name: 'test',
    version: '1',
  });
  vi.spyOn(permissions, 'contains').mockResolvedValue(false);
  vi.spyOn(permissions, 'request').mockResolvedValue(true);
  vi.spyOn(permissions, 'remove').mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Reader: what is saved depends on the window', () => {
  it('a private window says so, as a status message, before anything is opened', async () => {
    mount({ privacy: 'private' });
    const text = await screen.findByText(INCOGNITO_CAPTURE_REFUSAL, { exact: false });
    expect(text.closest('[role="status"]')).not.toBeNull();
    expect(screen.getByText('Nothing is being saved')).toBeTruthy();
    // The reader is still usable: the file chooser is there.
    expect(screen.getByRole('button', { name: 'Choose a PDF' })).toBeTruthy();
  });

  it('a window that cannot be told is treated the same way, in its own words', async () => {
    mount({ privacy: 'unknown' });
    expect(await screen.findByText(UNKNOWN_WINDOW_REFUSAL, { exact: false })).toBeTruthy();
  });

  it('a normal window, and a private one the person allowed, show no such message', async () => {
    mount({ privacy: 'normal' });
    await screen.findByRole('heading', { name: 'Open a PDF' });
    await settle();
    expect(screen.queryByText('Nothing is being saved')).toBeNull();
    cleanup();

    await setSettings({ allowIncognitoCapture: true });
    mount({ privacy: 'private' });
    await screen.findByRole('heading', { name: 'Open a PDF' });
    await settle();
    expect(screen.queryByText('Nothing is being saved')).toBeNull();
  });

  it.each([
    ['private', false, false],
    ['unknown', false, false],
    ['normal', false, true],
    ['private', true, true],
  ] as const)(
    'a %s window with "Save from private windows" %s opens a file with persist=%s',
    async (privacy, allow, persist) => {
      await setSettings({ allowIncognitoCapture: allow });
      mount({ privacy });
      await chooseFile();
      await waitFor(() => expect(openSession).toHaveBeenCalledTimes(1));
      expect(vi.mocked(openSession).mock.calls[0]![0]).toMatchObject({ persist });
    },
  );

  it('reads the setting when the document opens, not a copy from an earlier render', async () => {
    mount({ privacy: 'private' });
    await screen.findByText('Nothing is being saved');
    await setSettings({ allowIncognitoCapture: true });
    await chooseFile();
    await waitFor(() => expect(openSession).toHaveBeenCalledTimes(1));
    expect(vi.mocked(openSession).mock.calls[0]![0]).toMatchObject({ persist: true });
  });
});

describe('Reader: opening a kept copy (?doc=)', () => {
  const DOC = 'd'.repeat(64);
  const mountDoc = (store: ReturnType<typeof createMemoryPdfStore>) =>
    render(
      <Reader
        store={store}
        ocr={undefined}
        params={parseReaderParams(`?doc=${DOC}`)}
        privacy={vi.fn(async () => 'normal' as const)}
      />,
    );

  it('shows that the copy is being read, and opens it', async () => {
    const store = createMemoryPdfStore();
    let release: (b: Blob | null) => void = () => undefined;
    store.getDocumentBytes = () => new Promise((r) => (release = r));
    mountDoc(store);
    const loading = await screen.findByTestId('pdf-loading');
    expect(loading.textContent).toContain('Reading the stored copy');
    await act(async () => release(new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])])));
    await waitFor(() => expect(openSession).toHaveBeenCalledTimes(1));
  });

  it('a copy that cannot be read is an error with Retry, not "no copy"', async () => {
    const store = createMemoryPdfStore();
    store.getDocumentBytes = vi
      .fn()
      .mockRejectedValueOnce(new Error('The database is busy.'))
      .mockResolvedValueOnce(new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]));
    mountDoc(store);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not open the stored copy');
    expect(alert.textContent).toContain('The database is busy.');
    expect(screen.queryByText(/No stored copy/)).toBeNull();
    await userEvent.click(screen.getByTestId('pdf-stored-retry'));
    await waitFor(() => expect(openSession).toHaveBeenCalledTimes(1));
  });

  it('a document without a kept copy says so and offers the file chooser', async () => {
    mountDoc(createMemoryPdfStore());
    expect(await screen.findByText(/No stored copy of that PDF/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose a PDF' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Cancel while opening returns to the open screen and stays there', async () => {
    let finish: (s: unknown) => void = () => undefined;
    const destroy = vi.fn(async () => undefined);
    vi.mocked(openSession).mockImplementation(() => new Promise((r) => (finish = r)) as never);
    const store = createMemoryPdfStore();
    await store.cacheDocumentBytes!(DOC, new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]));
    mountDoc(store);
    await waitFor(() => expect(openSession).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByTestId('pdf-open')).toBeTruthy();
    // The open finishes after all: the document is let go, the open screen stays.
    await act(async () => finish({ id: DOC, doc: { destroy } }));
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('pdf-open')).toBeTruthy();
    expect(screen.queryByTestId('pdf-viewer')).toBeNull();
  });
});

describe('Reader: a typed web address', () => {
  it('is checked like ?src= and then follows the same permission steps', async () => {
    mount();
    await userEvent.click(await screen.findByText('From a link'));
    await userEvent.type(screen.getByTestId('pdf-link-input'), 'http://example.com/a.pdf');
    await userEvent.click(screen.getByTestId('pdf-link-open'));
    expect((await screen.findByRole('alert')).textContent).toContain('Only https addresses');
    expect(permissions.contains).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByTestId('pdf-link-input'));
    await userEvent.type(screen.getByTestId('pdf-link-input'), SRC);
    await userEvent.click(screen.getByTestId('pdf-link-open'));
    expect(await screen.findByTestId('pdf-allow-open')).toBeTruthy();
    expect(permissions.contains).toHaveBeenCalledWith({ origins: [A] });
  });
});

describe('Reader: site access for one fetch is handed back', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => pdf(SRC, { status: 404 })),
    );
  });

  it('asks for exactly the origin, from the click, and removes it when the fetch is over', async () => {
    mount({ src: SRC });
    await userEvent.click(await screen.findByTestId('pdf-allow-open'));

    await waitFor(() => expect(permissions.remove).toHaveBeenCalledTimes(1));
    expect(permissions.request).toHaveBeenCalledWith({ origins: [A] });
    expect(permissions.remove).toHaveBeenCalledWith({ origins: [A] });
    // The fetch ran in between, and its failure is reported.
    expect(await screen.findByText(/No file exists at that address/)).toBeTruthy();
  });

  it('leaves access the person already had: nothing is requested and nothing is removed', async () => {
    vi.mocked(permissions.contains).mockResolvedValue(true);
    mount({ src: SRC });
    expect(await screen.findByText(/No file exists at that address/)).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(permissions.request).not.toHaveBeenCalled();
    expect(permissions.remove).not.toHaveBeenCalled();
  });

  it('leaves an origin the person listed as a standing site, even if Chrome had dropped it', async () => {
    await setSettings({ persistentOrigins: [A] });
    mount({ src: SRC });
    await userEvent.click(await screen.findByTestId('pdf-allow-open'));
    expect(await screen.findByText(/No file exists at that address/)).toBeTruthy();
    expect(permissions.request).toHaveBeenCalledWith({ origins: [A] });
    expect(permissions.remove).not.toHaveBeenCalled();
  });

  it('leaves a grant that covers every site', async () => {
    await setSettings({ persistentOrigins: ['https://*/*'] });
    mount({ src: SRC });
    await userEvent.click(await screen.findByTestId('pdf-allow-open'));
    expect(await screen.findByText(/No file exists at that address/)).toBeTruthy();
    expect(permissions.remove).not.toHaveBeenCalled();
  });

  it('a declined request fetches nothing and has nothing to hand back', async () => {
    vi.mocked(permissions.request).mockResolvedValue(false);
    mount({ src: SRC });
    await userEvent.click(await screen.findByTestId('pdf-allow-open'));
    expect(await screen.findByText('Access was not granted')).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
    expect(permissions.remove).not.toHaveBeenCalled();
  });

  it('a redirect to a site that was not allowed asks for that site, and hands both back afterwards', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(pdf('https://cdn.example.net/blob?sig=1'))
      .mockResolvedValueOnce(pdf(SRC, { status: 404 }));
    mount({ src: SRC });
    await userEvent.click(await screen.findByTestId('pdf-allow-open'));

    // First fetch ended on cdn.example.net: refused, and what was requested for it is handed back.
    const allow = await screen.findByTestId('pdf-allow-redirect');
    expect(allow.textContent).toContain('cdn.example.net');
    await waitFor(() => expect(permissions.remove).toHaveBeenCalledWith({ origins: [A] }));
    expect(permissions.remove).toHaveBeenCalledTimes(1);

    // One prompt for both origins; both are handed back when that fetch is over.
    await userEvent.click(allow);
    await waitFor(() => expect(permissions.remove).toHaveBeenCalledTimes(3));
    expect(permissions.request).toHaveBeenLastCalledWith({ origins: [A, B] });
    const removed = vi.mocked(permissions.remove).mock.calls.map((c) => c[0].origins[0]);
    expect(removed.sort()).toEqual([A, A, B].sort());
  });
});

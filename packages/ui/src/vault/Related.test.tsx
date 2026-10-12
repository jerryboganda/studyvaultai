import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { RelatedHit, RelatedOptions, RelatedResult } from '@search';
import { RELATED_SHOWN, RelatedSection, type RelatedPort } from './Related';
import type { SearchHostState } from './searchHost';

afterEach(cleanup);

const READY: SearchHostState = { phase: 'ready', documents: 10, rejected: 0 };

function hit(id: string, over: Partial<RelatedHit['doc']> = {}, shared = ['warfarin', 'INR']) {
  return {
    highlightId: id,
    doc: {
      id,
      docType: 'highlight',
      highlightId: id,
      title: 'Anticoagulants',
      url: null,
      host: 'pharm.example',
      quote: `Quote of ${id}`,
      comment: '',
      headingContext: null,
      tags: [],
      banks: [],
      folderPath: [],
      kind: 'essential',
      priority: 3,
      resolveStatus: 'resolved',
      updatedAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
      ...over,
    },
    score: 1,
    sharedTerms: shared,
    explanation: `shares: ${shared.join(', ')}`,
  } satisfies RelatedHit;
}

const result = (hits: RelatedHit[], over: Partial<RelatedResult> = {}): RelatedResult => ({
  found: true,
  hits,
  total: hits.length,
  terms: ['warfarin', 'INR'],
  took: 1,
  ...over,
});

function port(over: Partial<RelatedPort> = {}) {
  const find = vi.fn<(id: string, options: RelatedOptions) => RelatedResult>(() =>
    result([hit('h2'), hit('h3')]),
  );
  const p: RelatedPort = { state: READY, revision: 1, find, ...over };
  return { p, find };
}

const toggle = () => screen.getByTestId('related-toggle');

describe('RelatedSection', () => {
  it('is collapsed and computes nothing until it is opened', () => {
    const { p, find } = port({ request: vi.fn() });
    render(<RelatedSection id="h1" port={p} onOpen={() => undefined} />);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(toggle().textContent).toBe('Show related highlights');
    expect(find).not.toHaveBeenCalled();
    expect(p.request).not.toHaveBeenCalled();
    expect(screen.queryByTestId('related-item')).toBeNull();
    // the controlled region exists (aria-controls resolves) and is hidden
    const region = document.getElementById(toggle().getAttribute('aria-controls')!)!;
    expect(region.hidden).toBe(true);
  });

  it('asks for the index when opened, then lists the related highlights with the shared words', () => {
    const { p, find } = port({ request: vi.fn() });
    render(<RelatedSection id="h1" port={p} onOpen={() => undefined} />);
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(p.request).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith('h1', { limit: RELATED_SHOWN, excludeSameSource: false });

    const items = screen.getAllByTestId('related-item');
    expect(items.map((i) => i.getAttribute('data-highlight-id'))).toEqual(['h2', 'h3']);
    expect(within(items[0]!).getByTestId('related-why').textContent).toBe('shares: warfarin, INR');
    expect(items[0]!.textContent).toContain('Quote of h2');
    expect(items[0]!.textContent).toContain('Anticoagulants · pharm.example');
    expect(screen.getByTestId('related-summary').textContent).toBe('2 related highlights.');

    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('related-item')).toBeNull();
  });

  it('opens the chosen highlight and names it for assistive technology', () => {
    const onOpen = vi.fn();
    const { p } = port();
    render(<RelatedSection id="h1" port={p} onOpen={onOpen} openLabel="Open in dashboard" />);
    fireEvent.click(toggle());
    const button = screen.getAllByTestId('related-open')[1]!;
    expect(button.textContent).toBe('Open in dashboard');
    expect(button.getAttribute('aria-label')).toBe('Open in dashboard: Quote of h3');
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledWith('h3');
  });

  it('reports a failure to open next to the item', async () => {
    const { p } = port();
    render(
      <RelatedSection
        id="h1"
        port={p}
        onOpen={() => Promise.reject(new Error('Tab limit reached'))}
      />,
    );
    fireEvent.click(toggle());
    fireEvent.click(screen.getAllByTestId('related-open')[0]!);
    const item = screen.getAllByTestId('related-item')[0]!;
    await waitFor(() => expect(item.textContent).toContain('Tab limit reached'));
    expect(within(item).getByRole('alert')).toBeTruthy();
  });

  it('waits honestly while the index is not ready and lists as soon as it is', () => {
    const building: SearchHostState = {
      phase: 'building',
      reason: 'missing',
      done: 40,
      total: 100,
    };
    const { p, find } = port({ state: building });
    const { rerender } = render(<RelatedSection id="h1" port={p} onOpen={() => undefined} />);
    fireEvent.click(toggle());
    expect(screen.getByText(/Building the search index: 40 of 100/)).toBeTruthy();
    expect(find).not.toHaveBeenCalled();
    expect(screen.queryByTestId('related-other-sources')).toBeNull();

    rerender(<RelatedSection id="h1" port={{ ...p, state: READY }} onOpen={() => undefined} />);
    expect(find).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId('related-item')).toHaveLength(2);
  });

  it('says so when the index failed', () => {
    const { p, find } = port({ state: { phase: 'error', message: 'Index store unavailable' } });
    render(<RelatedSection id="h1" port={p} onOpen={() => undefined} />);
    fireEvent.click(toggle());
    expect(screen.getByRole('alert').textContent).toContain('Index store unavailable');
    expect(find).not.toHaveBeenCalled();
  });

  it('recomputes when the index content changed and not otherwise', () => {
    const { p, find } = port();
    const { rerender } = render(<RelatedSection id="h1" port={p} onOpen={() => undefined} />);
    fireEvent.click(toggle());
    expect(find).toHaveBeenCalledTimes(1);
    rerender(<RelatedSection id="h1" port={p} onOpen={() => undefined} />);
    expect(find).toHaveBeenCalledTimes(1);
    rerender(<RelatedSection id="h1" port={{ ...p, revision: 2 }} onOpen={() => undefined} />);
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('can hide highlights from the same source', () => {
    const { p, find } = port();
    render(<RelatedSection id="h1" port={p} onOpen={() => undefined} />);
    fireEvent.click(toggle());
    fireEvent.click(screen.getByTestId('related-other-sources'));
    expect(find).toHaveBeenLastCalledWith('h1', { limit: RELATED_SHOWN, excludeSameSource: true });
  });

  it('has an honest empty state', () => {
    const { p } = port();
    p.find = vi.fn(() => result([], { terms: [] }));
    render(<RelatedSection id="h1" port={p} onOpen={() => undefined} />);
    fireEvent.click(toggle());
    expect(screen.queryByTestId('related-item')).toBeNull();
    expect(screen.getByTestId('related-summary').textContent).toMatch(
      /^No other highlight shares enough words with this one yet\./,
    );
  });

  it('says when the highlight is not indexed yet and when the lookup fails', () => {
    const missing = port();
    missing.p.find = vi.fn(() => result([], { found: false, terms: [] }));
    render(<RelatedSection id="h1" port={missing.p} onOpen={() => undefined} />);
    fireEvent.click(toggle());
    expect(screen.getByTestId('related-summary').textContent).toMatch(
      /not in the search index yet/,
    );
    cleanup();

    const broken = port();
    broken.p.find = vi.fn(() => {
      throw new Error('The search index is not ready yet.');
    });
    render(<RelatedSection id="h1" port={broken.p} onOpen={() => undefined} />);
    fireEvent.click(toggle());
    expect(screen.getByRole('alert').textContent).toContain('The search index is not ready yet.');
  });

  it('counts the ones it does not show and renders stored text as text', () => {
    const { p } = port();
    p.find = vi.fn(() =>
      result([hit('h2', { quote: '<img src=x onerror=alert(1)> <b>bold</b>' })], { total: 14 }),
    );
    render(<RelatedSection id="h1" port={p} onOpen={() => undefined} />);
    fireEvent.click(toggle());
    expect(screen.getByTestId('related-summary').textContent).toBe(
      '14 related highlights; showing the 1 most related.',
    );
    const item = screen.getByTestId('related-item');
    expect(item.querySelector('img, b')).toBeNull();
    expect(item.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeChromeFakes } from '../../testing/fakes';
import { browser } from 'wxt/browser';
import type { AiResult } from '@ai';
import {
  listAllRelations,
  resolveAiSources,
  saveAiResult,
  softDeleteHighlight,
  type AiSourceRef,
} from '@storage';
import { freshDatabase, save } from '@storage/test-vault';
import { AiResultCard } from '../AiResultCard';
import { CONTRADICTION_LINK_NOTE, LinkContradiction } from '../LinkContradiction';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

beforeEach(async () => {
  await freshDatabase();
  Object.assign(browser, makeChromeFakes());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(cleanup);

const Q1 = 'The recommended adult dose of the drug is 500 mg twice daily with food.';
const Q2 = 'The recommended adult dose of the drug is 250 mg once daily on an empty stomach.';

async function pair() {
  const h1 = await save(Q1);
  const h2 = await save(Q2);
  const refs = await resolveAiSources([h1.id, h2.id]);
  return { h1, h2, a: refs.get(h1.id)!, b: refs.get(h2.id)! };
}

function contradictions(ids: [string, string], supported = true): AiResult {
  const claim = (end: 'a' | 'b', quoteId: string) => ({
    path: `/contradictions/0/${end}/text`,
    quoteId,
    supported,
    reason: supported ? ('ok' as const) : ('quote_not_found' as const),
  });
  return {
    id: 'result-contradictions-0001',
    kind: 'contradictions',
    inputSourceIds: ids,
    inputFingerprint: 'a'.repeat(64),
    provider: 'mock',
    model: 'mock-1',
    templateVersion: 'contradictions-v1',
    citations: [],
    verificationState: 'unverified',
    usage: { inputTokens: 10, outputTokens: 10, estimatedCostUsd: null },
    createdAt: '2026-10-11T10:00:00.000Z',
    acceptedByUserAt: null,
    consentRef: 'consent-0001',
    grounding: {
      checked: 2,
      supported: supported ? 2 : 0,
      unsupported: supported ? 0 : 2,
      claims: [claim('a', ids[0]), claim('b', ids[1])],
    },
    notices: [],
    output: {
      candidateCount: 1,
      contradictions: [
        {
          a: { quoteId: ids[0], text: 'dose of the drug is 500 mg twice daily' },
          b: { quoteId: ids[1], text: 'dose of the drug is 250 mg once daily' },
          explanation: 'The two passages give different doses.',
        },
      ],
    },
  };
}

describe('LinkContradiction', () => {
  it('stores a plain "contradicts" link and says where to find it', async () => {
    const { h1, h2, a, b } = await pair();
    render(<LinkContradiction a={a} b={b} grounded />);
    await userEvent.click(screen.getByTestId('ai-link-contradiction-button'));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/^Linked as Contradicts/),
    );
    const stored = await listAllRelations();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      fromKind: 'highlight',
      fromId: h1.id,
      toKind: 'highlight',
      toId: h2.id,
      type: 'contradicts',
      note: CONTRADICTION_LINK_NOTE,
    });
    // what the model said is not part of it
    expect(JSON.stringify(stored)).not.toContain('different doses');
  });

  it('says so when the pair is already linked', async () => {
    const { a, b } = await pair();
    const first = render(<LinkContradiction a={a} b={b} grounded />);
    await userEvent.click(screen.getByTestId('ai-link-contradiction-button'));
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    first.unmount();
    render(<LinkContradiction a={a} b={b} grounded />);
    await userEvent.click(screen.getByTestId('ai-link-contradiction-button'));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/already linked as Contradicts/),
    );
    expect(await listAllRelations()).toHaveLength(1);
  });

  it('is not offered for an unmatched quote, a missing passage or one passage twice', async () => {
    const { a, b } = await pair();
    const gone: AiSourceRef = { ...b, deleted: true };
    const cases: Array<[AiSourceRef | undefined, AiSourceRef | undefined, boolean]> = [
      [a, b, false],
      [a, gone, true],
      [a, undefined, true],
      [a, a, true],
    ];
    for (const [x, y, grounded] of cases) {
      const view = render(<LinkContradiction a={x} b={y} grounded={grounded} />);
      expect(screen.queryByTestId('ai-link-contradiction')).toBeNull();
      view.unmount();
    }
  });
});

describe('a reported contradiction in a result card', () => {
  it('offers the link for matched quotes and writes it on a click', async () => {
    const { h1, h2 } = await pair();
    const stored = await saveAiResult(contradictions([h1.id, h2.id]));
    render(<AiResultCard result={stored} />);
    const button = await screen.findByTestId('ai-link-contradiction-button');
    await userEvent.click(button);
    await waitFor(async () => expect(await listAllRelations()).toHaveLength(1));
    expect((await listAllRelations())[0]).toMatchObject({ type: 'contradicts', fromId: h1.id });
  });

  it("does not offer it when the model's quotes could not be matched", async () => {
    const { h1, h2 } = await pair();
    const stored = await saveAiResult(contradictions([h1.id, h2.id], false));
    render(<AiResultCard result={stored} />);
    await screen.findAllByTestId('ai-unsupported');
    expect(screen.queryByTestId('ai-link-contradiction-button')).toBeNull();
  });

  it('does not offer it once one of the passages is in the trash', async () => {
    const { h1, h2 } = await pair();
    const stored = await saveAiResult(contradictions([h1.id, h2.id]));
    await softDeleteHighlight(h2.id);
    render(<AiResultCard result={stored} />);
    await screen.findByTestId('ai-citation-missing');
    expect(screen.queryByTestId('ai-link-contradiction-button')).toBeNull();
  });
});

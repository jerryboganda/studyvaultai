import type { HtmlAnchorSet } from '@shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveAnchor, resolveMany } from './resolve';
import { buildTextStream, streamTextOfRange } from './textStream';
import { capture, captureRange, rangeOver, setBody } from './testUtils';
import type { Resolution } from './types';

beforeEach(() => {
  document.body.innerHTML = '';
});

/** Resolve against a freshly built stream, the way a page reload does. */
function resolveFresh(anchor: HtmlAnchorSet): Resolution {
  return resolveAnchor(anchor, buildTextStream());
}

function expectResolved(res: Resolution, text: string): void {
  expect(res.status).toBe('resolved');
  expect(res.range).not.toBeNull();
  expect(streamTextOfRange(res.range!)).toBe(text);
}

describe('round trip: capture -> resolve on the unchanged page', () => {
  it('single text node', () => {
    setBody('<p>The quick brown fox jumps over the lazy dog.</p>');
    const { anchorSet } = capture('brown fox jumps');
    const res = resolveFresh(anchorSet);
    expectResolved(res, 'brown fox jumps');
    expect(res.confidence).toBe(1);
    expect(res.range!.toString()).toBe('brown fox jumps');
  });

  it('multiple inline elements (links, strong, em)', () => {
    setBody(
      '<p>The <a href="#x">quick</a> <strong>brown <em>fox</em></strong> jumps over the lazy dog.</p>',
    );
    const { anchorSet } = capture('quick brown fox jumps');
    expectResolved(resolveFresh(anchorSet), 'quick brown fox jumps');
  });

  it('inline math-like spans', () => {
    setBody(
      '<p>Let <span class="m">x</span><sup>2</sup> + <span class="m">y</span><sup>2</sup> = <span class="m">z</span><sup>2</sup> hold for the triangle.</p>',
    );
    const { anchorSet } = capture('x2 + y2 = z2 hold');
    const res = resolveFresh(anchorSet);
    expectResolved(res, 'x2 + y2 = z2 hold');
  });

  it('across blocks', () => {
    setBody(
      '<h2>Title</h2><p>First paragraph text ends here.</p><p>Second paragraph text starts here.</p>',
    );
    const { anchorSet } = capture('ends here.Second paragraph');
    expectResolved(resolveFresh(anchorSet), 'ends here.Second paragraph');
  });

  it('across table cells and rows', () => {
    setBody(
      '<table><tbody><tr><td>Alpha</td><td>Beta</td></tr><tr><td>Gamma</td><td>Delta</td></tr></tbody></table>',
    );
    const { anchorSet } = capture('BetaGamma');
    const res = resolveFresh(anchorSet);
    expectResolved(res, 'BetaGamma');
    expect(res.range!.startContainer.parentElement!.tagName).toBe('TD');
  });

  it('element-boundary (triple-click) selection', () => {
    setBody('<p id="p1">Select this whole paragraph by triple clicking.</p><p id="p2">Next.</p>');
    const range = document.createRange();
    range.setStart(document.getElementById('p1')!, 0);
    range.setEnd(document.getElementById('p2')!, 0);
    const captured = captureRange(range, 'Select this whole paragraph by triple clicking.\n');
    const res = resolveFresh(captured.anchorSet);
    expectResolved(res, 'Select this whole paragraph by triple clicking.');
    expect(res.range!.toString()).toBe('Select this whole paragraph by triple clicking.');
  });

  it('whitespace, newline and NBSP differences between visits do not matter', () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p>');
    const { anchorSet } = capture('gamma delta epsilon');
    setBody('<p>\n   Alpha\u00A0beta\n\tgamma   delta\u00A0 epsilon \n zeta eta theta.\n</p>');
    const res = resolveFresh(anchorSet);
    expectResolved(res, 'gamma delta epsilon');
    expect(res.confidence).toBe(1);
  });
});

describe('repeated quotations', () => {
  it('disambiguates identical quotes by prefix/suffix context', () => {
    setBody(
      '<p>Alpha section says the mitochondria generate energy for cells.</p><p>Beta section says the mitochondria also regulate calcium signalling.</p>',
    );
    const { anchorSet } = capture('mitochondria', 1);
    // The page changes elsewhere, so the byte-identical shortcut cannot apply.
    setBody(
      '<p>Intro added.</p><p>Alpha section says the mitochondria generate energy for cells.</p><p>Beta section says the mitochondria also regulate calcium signalling.</p>',
    );
    const res = resolveFresh(anchorSet);
    expectResolved(res, 'mitochondria');
    expect(res.method).toBe('context');
    expect(res.candidateCount).toBe(2);
    // It is the second occurrence (inside the Beta paragraph).
    expect(res.range!.startContainer.textContent).toContain('Beta section');
  });

  it('keeps the first of two identical words when context says so', () => {
    setBody('<p>the cat sat on the mat while the dog slept under the table</p>');
    const { anchorSet } = capture('the', 0);
    setBody('<p>NEW the cat sat on the mat while the dog slept under the table</p>');
    const res = resolveFresh(anchorSet);
    expect(res.status).toBe('resolved');
    expect(res.range!.startOffset).toBe('NEW '.length);
  });

  it('identical paragraphs on an unchanged page resolve by exact position', () => {
    const para = '<p>This exact paragraph is repeated word for word on the page for testing.</p>';
    setBody(para.repeat(5));
    const { anchorSet } = capture('repeated word for word', 2);
    const res = resolveFresh(anchorSet);
    expectResolved(res, 'repeated word for word');
    expect(res.method).toBe('position');
    expect(res.candidateCount).toBe(5);
    expect(res.range!.startContainer.parentElement).toBe(document.body.children[2]);
  });

  it('identical paragraphs become ambiguous (never a guess) once position cannot be trusted', () => {
    const para = '<p>This exact paragraph is repeated word for word on the page for testing.</p>';
    setBody(para.repeat(5));
    const { anchorSet } = capture('repeated word for word', 2);
    // One more copy is inserted above: every copy shifts, signature changes, contexts tie.
    setBody(para.repeat(6));
    const res = resolveFresh(anchorSet);
    expect(res.status).toBe('ambiguous');
    expect(res.range).toBeNull();
    expect(res.candidateCount).toBe(6);
  });

  it('a first-of-many copy loses its document-start context and is ambiguous, not guessed', () => {
    const para = '<p>This exact paragraph is repeated word for word on the page for testing.</p>';
    setBody(para.repeat(4));
    const { anchorSet } = capture('repeated word for word', 0);
    expect(anchorSet.textQuote.prefix).toBe('This exact paragraph is '); // quote is not at stream 0
    setBody('<p>Banner.</p>' + para.repeat(4));
    const res = resolveFresh(anchorSet);
    // Copies 0..2 now share identical prefix and suffix contexts and the page changed, so the
    // stored position cannot be trusted to pick one.
    expect(res.status).toBe('ambiguous');
    expect(res.range).toBeNull();
    expect(res.candidateCount).toBe(4);
  });
});

describe('short quotes', () => {
  it('a lone short match with both contexts and position changed is ambiguous', () => {
    setBody(
      '<p>As the plot in the left panel shows, Figure 1 summarises the results of the study.</p>',
    );
    const { anchorSet } = capture('Figure 1');
    setBody(
      '<p>Completely different prose now surrounds this caption and nothing else: Figure 1 appears somewhere new entirely.</p>',
    );
    const res = resolveFresh(anchorSet);
    expect(res.status).toBe('ambiguous');
    expect(res.range).toBeNull();
    expect(res.candidateCount).toBe(1);
  });

  it('a lone short match is accepted when one side of the context still agrees', () => {
    setBody('<p>As the plot in the left panel shows, Figure 1 summarises the results.</p>');
    const { anchorSet } = capture('Figure 1');
    setBody('<p>NEW. As the plot in the left panel shows, Figure 1 summarises the results.</p>');
    expectResolved(resolveFresh(anchorSet), 'Figure 1');
  });

  it('a lone long quote is accepted even if all context changed', () => {
    setBody(
      '<p>Before text one. The ratio of surface area to volume decreases as cells grow larger. After text one.</p>',
    );
    const { anchorSet } = capture(
      'The ratio of surface area to volume decreases as cells grow larger.',
    );
    setBody(
      '<div><h3>Moved</h3><p>Totally unrelated lead in. The ratio of surface area to volume decreases as cells grow larger. And an unrelated tail.</p></div>',
    );
    const res = resolveFresh(anchorSet);
    expect(res.status).toBe('resolved');
    expect(res.method).toBe('quote');
    expect(res.confidence).toBeGreaterThanOrEqual(0.9);
  });
});

describe('source mutated after capture', () => {
  const quote = 'Osmosis is the net movement of water across a selectively permeable membrane';
  const base = (before = '', inside = quote, after = '') =>
    `<h1>Transport</h1>${before}<p>Intro sentence one. ${inside} down its gradient.</p>${after}<p>Closing paragraph about diffusion and other things.</p>`;

  it('text inserted before the quote shifts the position but still resolves by quote', () => {
    setBody(base());
    const { anchorSet } = capture(quote);
    setBody(base('<p>A brand new paragraph that was inserted above the highlighted passage.</p>'));
    const res = resolveFresh(anchorSet);
    expectResolved(res, quote);
    expect(res.method).toBe('quote');
    expect(res.range!.startOffset).toBeGreaterThan(0);
  });

  it('a word edited inside the quote is found fuzzily and flagged changed', () => {
    setBody(base());
    const { anchorSet } = capture(quote);
    setBody(base('', quote.replace('selectively', 'selecively')));
    const res = resolveFresh(anchorSet);
    expect(res.status).toBe('changed');
    expect(res.method).toBe('fuzzy');
    expect(res.confidence).toBeGreaterThanOrEqual(0.85);
    expect(res.confidence).toBeLessThan(1);
    expect(res.range!.toString()).toBe(quote.replace('selectively', 'selecively'));
  });

  it('a heavily rewritten quote falls below 0.85 and is orphaned', () => {
    setBody(base());
    const { anchorSet } = capture(quote);
    setBody(base('', 'Water moves through membranes because of concentration differences'));
    const res = resolveFresh(anchorSet);
    expect(res.status).toBe('orphaned');
    expect(res.range).toBeNull();
    expect(res.method).toBe('none');
  });

  it('a deleted paragraph is orphaned', () => {
    setBody(
      '<h1>T</h1><p>Paragraph one is here and stays.</p><p>' +
        quote +
        ' and is going to be deleted soon.</p><p>Paragraph three remains too.</p>',
    );
    const { anchorSet } = capture(quote);
    setBody('<h1>T</h1><p>Paragraph one is here and stays.</p><p>Paragraph three remains too.</p>');
    const res = resolveFresh(anchorSet);
    expect(res.status).toBe('orphaned');
    expect(res.range).toBeNull();
  });

  it('a moved quote is resolved by the quote itself', () => {
    setBody(base());
    const { anchorSet } = capture(quote);
    setBody(
      `<h1>Transport</h1><p>Intro sentence one. down its gradient.</p><p>Closing paragraph about diffusion and other things.</p><aside><p>Appendix: ${quote} as discussed earlier.</p></aside>`,
    );
    const res = resolveFresh(anchorSet);
    expectResolved(res, quote);
    expect(res.range!.startContainer.parentElement!.closest('aside')).not.toBeNull();
  });

  it('fuzzy match follows the quote when its surroundings moved too', () => {
    setBody(base());
    const { anchorSet } = capture(quote);
    const edited = quote.replace('permeable', 'permeabel');
    setBody(
      `<h1>Transport</h1><p>${'Lots of new introductory words. '.repeat(8)}</p><p>Intro sentence one. ${edited} down its gradient.</p>`,
    );
    const res = resolveFresh(anchorSet);
    expect(res.status).toBe('changed');
    expect(res.range!.toString()).toBe(edited);
  });

  it('two similar fuzzy candidates are ambiguous rather than guessed', () => {
    const q = 'The enzyme catalyses the hydrolysis of the peptide bond in the substrate';
    setBody(`<p>Intro one.</p><p>${q}.</p><p>Outro one.</p>`);
    const { anchorSet } = capture(q);
    const a = q.replace('enzyme', 'enzime');
    const b = q.replace('substrate', 'substrat');
    setBody(`<p>Intro one.</p><p>${a}.</p><p>middle filler text</p><p>${b}.</p><p>Outro one.</p>`);
    const res = resolveFresh(anchorSet);
    expect(res.status).toBe('ambiguous');
    expect(res.range).toBeNull();
  });
});

describe('never silently wrong (conflicting evidence)', () => {
  const quote = 'The enzyme catalyses the hydrolysis of the peptide bond in the substrate';

  it('an edited original is not replaced by a verbatim copy elsewhere (abstract repeats body)', () => {
    setBody(`<p>Abstract: nothing here.</p><p>Body. ${quote}. More body.</p><p>The end.</p>`);
    const { anchorSet } = capture(quote);
    setBody(
      `<p>Abstract: nothing here.</p><p>Body. ${quote.replace('hydrolysis', 'hydrolysys')}. More body.</p><p>The end.</p><aside>Summary: ${quote}</aside>`,
    );
    const res = resolveFresh(anchorSet);
    expect(res.status).toBe('ambiguous');
    expect(res.range).toBeNull();
  });

  it('an edited original with no copy anywhere is found in place as changed', () => {
    setBody(`<p>Abstract: nothing here.</p><p>Body. ${quote}. More body.</p><p>The end.</p>`);
    const { anchorSet } = capture(quote);
    const edited = quote.replace('hydrolysis', 'hydrolysys');
    setBody(`<p>Abstract: nothing here.</p><p>Body. ${edited}. More body.</p><p>The end.</p>`);
    const res = resolveFresh(anchorSet);
    expect(res.status).toBe('changed');
    expect(res.range!.toString()).toBe(edited);
  });

  it('a copy inserted right before the original (same prefix, same offset) is ambiguous, not chosen', () => {
    setBody(`<p>Lead in paragraph.</p><p>${quote}</p><p>Trailing paragraph that follows.</p>`);
    const { anchorSet } = capture(quote);
    // New content with the same sentence lands exactly where the original was; the original is
    // pushed down. One copy matches the text before, the other the text after.
    setBody(
      `<p>Lead in paragraph.</p><p>${quote} (reprinted)</p><p>${quote}</p><p>Trailing paragraph that follows.</p>`,
    );
    const res = resolveFresh(anchorSet);
    expect(res.status).toBe('ambiguous');
    expect(res.range).toBeNull();
    expect(res.candidateCount).toBe(2);
  });

  it('content inserted just above the quote still resolves (only the prefix side changed)', () => {
    setBody(`<p>Lead in paragraph.</p><p>${quote}</p><p>Trailing paragraph that follows.</p>`);
    const { anchorSet } = capture(quote);
    setBody(
      `<p>Lead in paragraph.</p><p>A freshly added note sits here.</p><p>${quote}</p><p>Trailing paragraph that follows.</p>`,
    );
    expectResolved(resolveFresh(anchorSet), quote);
  });

  it('a quote at the very end of the page is not confused with a copy placed at the new end', () => {
    setBody(`<p>Some introduction text goes here.</p><p>${quote}</p>`);
    const { anchorSet } = capture(quote);
    // Same sentence now also closes a different section and trailing whitespace noise is added.
    setBody(
      `<p>Some introduction text goes here.</p><p>${quote}</p><p>Appendix.</p><p>${quote}</p>\n`,
    );
    const res = resolveFresh(anchorSet);
    // The copy at the end matches the stored "end of document" suffix; the original matches the
    // stored prefix. Half-supported on both: must not guess.
    expect(res.status).toBe('ambiguous');
  });
});

describe('conflicting evidence: deterministic regressions found by the property tests', () => {
  const P = 'gradient transport ';
  const Q = '\u00e9clair nucleus osmosis in ribosome nucleus membrane thepathway protein';
  const S =
    'to to ribosome alpha beta alpha gamma delta enzyme receptor binding cell ratio signal pathway';

  it('a decoy at the old offset with the old prefix does not beat an intact original that kept its suffix', () => {
    setBody(`<p>${P}</p><p>${Q}</p><p>${S}</p>`);
    const { anchorSet } = capture(Q);
    setBody(`<p>${P}</p><p>${Q} a osmosis protein cafe ribosome ${Q}</p><p>${Q}</p><p>${S}</p>`);
    const res = resolveFresh(anchorSet);
    // decoy copy 1: same offset + full prefix. original: full suffix. Neither has both sides.
    expect(res.status).toBe('ambiguous');
    expect(res.range).toBeNull();
    expect(res.candidateCount).toBe(3);
  });

  it('a rewritten neighbourhood does not hand the highlight to a copy that matches the old context', () => {
    const before = 'Preceding context sentence that is long enough to fill the window.';
    const after = 'Following context sentence that is also long enough to fill it.';
    const tail = '<p>Unrelated closing paragraph with a good number of words in it.</p>';
    setBody(`<p>${before}</p><p>${Q}</p><p>${after}</p>${tail}`);
    const { anchorSet } = capture(Q);
    // Same-length rewrite in place (the quote stays at its exact offset) plus an archived copy
    // that still has the old context.
    const x = (t: string): string => t.replace(/[a-z]/gi, 'x');
    setBody(
      `<p>${x(before)}</p><p>${Q}</p><p>${x(after)}</p>${tail}<p>${before}</p><p>${Q}</p><p>${after}</p>`,
    );
    const res = resolveFresh(anchorSet);
    expect(res.status).toBe('ambiguous');
    expect(res.range).toBeNull();
  });

  it('a stale stream (text replaced in place since it was built) is orphaned, never painted', () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda.</p>');
    const { anchorSet, stream } = capture('gamma delta epsilon');
    const node = document.querySelector('p')!.firstChild as Text;
    node.data = node.data.replace('gamma delta epsilon', 'GAMMA DELTA EPSILON');
    const res = resolveAnchor(anchorSet, stream); // `stream` still says "gamma delta epsilon"
    expect(res.status).toBe('orphaned');
    expect(res.range).toBeNull();
  });

  it('a stale stream whose node was detached is orphaned', () => {
    setBody('<p id="a">Alpha beta gamma delta</p><p id="b">epsilon zeta eta theta iota kappa</p>');
    const { anchorSet, stream } = capture('zeta eta theta');
    document.getElementById('b')!.remove();
    const res = resolveAnchor(anchorSet, stream);
    expect(res.status).toBe('orphaned');
    expect(res.range).toBeNull();
  });
});

describe('occurrence cap', () => {
  it('a word that occurs thousands of times is bounded to 200 candidates and never guessed', () => {
    setBody(`<p>${'word '.repeat(5000)}</p>`);
    const { anchorSet } = capture('word', 2500);
    // Unchanged page: the stored offset is authoritative even among 5000 identical copies.
    const same = resolveFresh(anchorSet);
    expect(same.status).toBe('resolved');
    expect(same.method).toBe('position');
    expect(same.candidateCount).toBe(200);
    // Changed page: nothing separates the copies.
    setBody(`<p>Banner. ${'word '.repeat(5000)}</p>`);
    const t0 = performance.now();
    const res = resolveFresh(anchorSet);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(res.status).toBe('ambiguous');
    expect(res.range).toBeNull();
    expect(res.candidateCount).toBe(200);
  });
});

describe('excluded and hidden content', () => {
  it('a quote spanning a script element resolves and excludes the script text', () => {
    setBody(
      '<p>Alpha beta <script>var a = 1;</script>gamma delta epsilon zeta eta theta iota.</p>',
    );
    const range = rangeOver('beta ');
    const end = rangeOver('gamma delta');
    range.setEnd(end.endContainer, end.endOffset);
    const captured = captureRange(range, range.toString());
    expect(captured.anchorSet.textQuote.exact).toBe('beta gamma delta');
    const res = resolveFresh(captured.anchorSet);
    expectResolved(res, 'beta gamma delta');
    expect(res.range!.toString()).toContain('var a = 1;'); // the DOM range does span it...
    expect(streamTextOfRange(res.range!)).not.toContain('var'); // ...but the quote does not
  });

  it('hidden text stays anchorable and visibility toggles never shift offsets', () => {
    setBody(
      '<div id="acc"><p>Hidden accordion body that contains the answer to the question.</p></div><p>Visible paragraph that follows the accordion body in order.</p>',
    );
    const { anchorSet } = capture('Visible paragraph that follows');
    (document.getElementById('acc') as HTMLElement).style.display = 'none';
    const hidden = resolveFresh(anchorSet);
    expectResolved(hidden, 'Visible paragraph that follows');
    expect(hidden.confidence).toBe(1);
    (document.getElementById('acc') as HTMLElement).style.display = '';
    expect(resolveFresh(anchorSet).status).toBe('resolved');
  });

  it('the injected StudyVault overlay does not move anchors', () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta iota kappa.</p>');
    const { anchorSet } = capture('gamma delta epsilon');
    const host = document.createElement('div');
    host.setAttribute('data-studyvault', '');
    host.textContent = 'StudyVault toolbar text that must not count';
    document.body.prepend(host);
    const res = resolveFresh(anchorSet);
    expectResolved(res, 'gamma delta epsilon');
    expect(res.confidence).toBe(1);
  });
});

describe('contract details', () => {
  it('a different text algorithm is orphaned (needs a migration, never a guess)', () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta.</p>');
    const { anchorSet } = capture('beta gamma');
    const future = { ...anchorSet, textAlgorithm: 'sv-text-v2' } as unknown as HtmlAnchorSet;
    const res = resolveFresh(future);
    expect(res).toEqual({
      status: 'orphaned',
      confidence: 0,
      range: null,
      method: 'none',
      candidateCount: 0,
    });
  });

  it('ambiguous and orphaned results never carry a range', () => {
    setBody('<p>aaaa bbbb cccc dddd</p>');
    const { anchorSet } = capture('bbbb');
    setBody('<p>xxxx</p>');
    const res = resolveFresh(anchorSet);
    expect(res.range).toBeNull();
  });

  it('an anchor that is not at its stored offset is never mapped to the wrong text by the byte-identical shortcut', () => {
    setBody('<p>one two three four five six seven eight nine ten</p>');
    const { anchorSet } = capture('three four');
    const tampered: HtmlAnchorSet = {
      ...anchorSet,
      textPosition: { start: 0, end: 10 },
    };
    const res = resolveFresh(tampered);
    expectResolved(res, 'three four');
  });

  it('resolveMany matches resolveAnchor and computes the signature once', () => {
    setBody(
      Array.from(
        { length: 12 },
        (_, i) => `<p>Paragraph number ${i} carries a unique and memorable sentence ${i * 7}.</p>`,
      ).join(''),
    );
    const entries = Array.from({ length: 12 }, (_, i) => ({
      id: `h${i}`,
      anchorSet: capture(`unique and memorable sentence ${i * 7}`).anchorSet,
    }));
    const real = buildTextStream();
    let signatureReads = 0;
    const counting = {
      text: real.text,
      segments: real.segments,
      root: real.root,
      get signature() {
        signatureReads++;
        return real.signature;
      },
    };
    const many = resolveMany(entries, counting);
    expect(signatureReads).toBe(1);
    for (const e of entries) {
      const single = resolveAnchor(e.anchorSet, real);
      const got = many.get(e.id)!;
      expect(got.status).toBe(single.status);
      expect(got.confidence).toBe(single.confidence);
      expect(got.range!.toString()).toBe(single.range!.toString());
    }
  });
});

/**
 * Adversarial anchoring probes (review lens: anchoring correctness).
 *
 * Every test states the behaviour ADR-004 / CLAUDE.md promise ("never silently pick wrong text";
 * "lost although the quote is unambiguously present" is a defect). These started life as `it.fails`
 * probes that reproduced proven defects; each one was flipped to a plain `it` when its defect was
 * fixed, so a regression turns the suite red.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveAnchor, resolveMany } from './resolve';
import { buildTextStream } from './textStream';
import { capture, setBody } from './testUtils';
import type { Resolution } from './types';
import type { HtmlAnchorSet } from '@shared';

beforeEach(() => {
  document.body.innerHTML = '';
});

const resolveFresh = (anchor: HtmlAnchorSet): Resolution =>
  resolveAnchor(anchor, buildTextStream());

const ownerText = (res: Resolution): string =>
  res.range ? (res.range.startContainer.textContent ?? '') : '';

const STEPS =
  '<ul><li>Step 3: Press the red button now.</li><li>Step 4: Press the red button now.</li><li>Step 5: Release it.</li></ul>';

describe('occurrence cap scores the FIRST 200 copies, not the ones near the stored position', () => {
  const sentence = 'The powerhouse of the cell and its many roles in energy production.';
  const filler = Array.from(
    { length: 300 },
    (_, i) => `<p>Filler paragraph ${i} mentions a cell in passing.</p>`,
  ).join('');

  // F1: the real copy (301st "cell") used to be beyond the cap; an earlier look-alike won and was painted.
  it('never paints an earlier look-alike when the real copy is beyond the old 200 cap', () => {
    setBody(`<p>noise 1</p><p>Abstract. ${sentence}</p>${filler}<p>Body. ${sentence}</p>`);
    const { anchorSet } = capture('cell', 301);
    expect(anchorSet.textQuote.prefix).toContain('Body');
    // The page changes slightly elsewhere (counter, ad, timestamp): the byte-identical shortcut is gone.
    setBody(`<p>noise 12</p><p>Abstract. ${sentence}</p>${filler}<p>Body. ${sentence}</p>`);
    const res = resolveFresh(anchorSet);
    expect(res.status).toBe('resolved');
    expect(ownerText(res).startsWith('Body.')).toBe(true);
    expect(res.candidateCount).toBe(302);
  });

  // F1b: no look-alike at all, context intact (64 chars agree), used to be lost.
  it('finds a quote with intact context even when it is the 250th of 300 copies', () => {
    const items = Array.from(
      { length: 300 },
      (_, i) => `<p>Section ${i}: the claim is not valid in case ${i}.</p>`,
    ).join('');
    setBody(`<p>0 visits</p>${items}`);
    const { anchorSet } = capture('not', 250);
    setBody(`<p>10 visits</p>${items}`);
    const res = resolveFresh(anchorSet);
    expect(res.status).toBe('resolved');
    expect(ownerText(res)).toContain('Section 250:');
  });
});

describe('fuzzy ("changed") must not bind to a near-duplicate sibling', () => {
  // F2: step 3 was deleted; "Step 4" differs by one character and used to be painted as the user's highlight.
  it('a deleted list item is not replaced by its nearly identical neighbour', () => {
    setBody(STEPS);
    const { anchorSet } = capture('Step 3: Press the red button now.');
    setBody('<ul><li>Step 4: Press the red button now.</li><li>Step 5: Release it.</li></ul>');
    const res = resolveFresh(anchorSet);
    expect(res.range).toBeNull(); // ambiguous (figure guard); never "changed" on Step 4
    expect(res.status).toBe('ambiguous');
  });

  // F2b: both steps were highlighted; deleting step 3 makes its highlight a second copy of step 4's.
  it('a highlight is not re-bound onto text another saved highlight already owns', () => {
    setBody(STEPS);
    const a = capture('Step 3: Press the red button now.');
    const b = capture('Step 4: Press the red button now.');
    setBody('<ul><li>Step 4: Press the red button now.</li><li>Step 5: Release it.</li></ul>');
    const out = resolveMany(
      [
        { id: 'a', anchorSet: a.anchorSet },
        { id: 'b', anchorSet: b.anchorSet },
      ],
      buildTextStream(),
    );
    expect(out.get('b')!.status).toBe('resolved');
    expect(out.get('a')!.range).toBeNull();
  });

  it('the owner need not be in the batch: `siblings` protects already painted highlights', () => {
    // Letters differ (not figures), so the figure guard cannot help: only ownership can.
    setBody(
      '<p>Item A: take the blue tablet daily with water.</p><p>Item B: take the blue tablet daily with water.</p>',
    );
    const itemA = capture('Item A: take the blue tablet daily with water.');
    const itemB = capture('Item B: take the blue tablet daily with water.');
    setBody('<p>Item B: take the blue tablet daily with water.</p>');
    const entries = [{ id: 'a', anchorSet: itemA.anchorSet }];
    // Nothing in the batch owns the text, so (documented) it binds: this is why the caller passes
    // the painted highlights as siblings.
    expect(resolveMany(entries, buildTextStream()).get('a')!.status).toBe('changed');
    const guarded = resolveMany(entries, buildTextStream(), { siblings: [itemB.anchorSet] });
    expect(guarded.get('a')!.range).toBeNull();
  });

  it('an edited highlight still finds its own text next to a verbatim look-alike sibling', () => {
    setBody(STEPS);
    const a = capture('Step 3: Press the red button now.');
    const b = capture('Step 4: Press the red button now.');
    // Step 3 was reworded (3 edits). Step 4 is only 1 edit away from Step 3's old text and is owned.
    setBody(
      '<ul><li>Step 3: Push the red button now.</li><li>Step 4: Press the red button now.</li><li>Step 5: Release it.</li></ul>',
    );
    const out = resolveMany(
      [
        { id: 'a', anchorSet: a.anchorSet },
        { id: 'b', anchorSet: b.anchorSet },
      ],
      buildTextStream(),
    );
    expect(out.get('b')!.status).toBe('resolved');
    const ra = out.get('a')!;
    expect(ra.status).toBe('changed');
    expect(ra.range!.toString()).toBe('Step 3: Push the red button now.');
  });

  it('a highlight nested inside another does not take its text away when the outer is edited', () => {
    const sentence = 'The enzyme catalyses the hydrolysis of the peptide bond in the substrate.';
    setBody(`<p>Intro paragraph here.</p><p>${sentence}</p><p>Outro paragraph here.</p>`);
    const outer = capture(sentence);
    const inner = capture('peptide bond');
    setBody(
      `<p>Intro paragraph here.</p><p>${sentence.replace('catalyses', 'catalizes')}</p><p>Outro paragraph here.</p>`,
    );
    const out = resolveMany(
      [
        { id: 'outer', anchorSet: outer.anchorSet },
        { id: 'inner', anchorSet: inner.anchorSet },
      ],
      buildTextStream(),
    );
    expect(out.get('inner')!.status).toBe('resolved');
    expect(out.get('outer')!.status).toBe('changed');
    expect(out.get('outer')!.range!.toString()).toContain('catalizes');
  });

  it('two different lost quotes that would both bind to one text are both withheld', () => {
    const lead = 'Dosage instruction for the patient: ';
    const rest = 'take the blue tablet daily with water.';
    setBody(`<p>${lead}Item A: ${rest}</p><p>${lead}Item B: ${rest}</p>`);
    const a = capture(`Item A: ${rest}`);
    const b = capture(`Item B: ${rest}`);
    setBody(`<p>${lead}Item C: ${rest}</p>`);
    // Alone, each one binds (one edit away) - that is the resolveAnchor contract...
    expect(resolveFresh(a.anchorSet).status).toBe('changed');
    expect(resolveFresh(b.anchorSet).status).toBe('changed');
    // ...but together they cannot both be right about the same text.
    const out = resolveMany(
      [
        { id: 'a', anchorSet: a.anchorSet },
        { id: 'b', anchorSet: b.anchorSet },
      ],
      buildTextStream(),
    );
    expect(out.get('a')!.range).toBeNull();
    expect(out.get('b')!.range).toBeNull();
    expect(out.get('a')!.status).toBe('ambiguous');
  });

  it('the same quote saved twice is not demoted when its text is edited', () => {
    const q = 'The enzyme catalyses the hydrolysis of the peptide bond in the substrate.';
    setBody(`<p>Intro.</p><p>${q}</p>`);
    const one = capture(q);
    const two = capture(q);
    setBody(`<p>Intro.</p><p>${q.replace('catalyses', 'catalizes')}</p>`);
    const out = resolveMany(
      [
        { id: 'one', anchorSet: one.anchorSet },
        { id: 'two', anchorSet: two.anchorSet },
      ],
      buildTextStream(),
    );
    expect(out.get('one')!.status).toBe('changed');
    expect(out.get('two')!.status).toBe('changed');
  });
});

describe('figure guard (numbers and negation) for short quotes', () => {
  const dose = 'Take 5 mg of the drug daily with food.';

  it('a corrected dose is not silently bound: ambiguous, never painted', () => {
    setBody(`<p>Intro text. ${dose} Then rest.</p>`);
    const { anchorSet } = capture(dose);
    setBody(`<p>Intro text. ${dose.replace('5 mg', '6 mg')} Then rest.</p>`);
    const res = resolveFresh(anchorSet);
    expect(res.status).toBe('ambiguous');
    expect(res.range).toBeNull();
  });

  it('a removed negation is not silently bound', () => {
    const q = 'The result is not statistically significant at this level.';
    setBody(`<p>Intro text. ${q} Then more.</p>`);
    const { anchorSet } = capture(q);
    setBody('<p>Intro text. The result is statistically significant at this level. Then more.</p>');
    const res = resolveFresh(anchorSet);
    expect(res.range).toBeNull();
  });

  it('a figure change together with a real edit of letters is still an edit of the same text', () => {
    setBody(`<p>Intro text. ${dose} Then rest.</p>`);
    const { anchorSet } = capture(dose);
    setBody(
      `<p>Intro text. ${dose.replace('5 mg', '6 mg').replace('daily', 'dayly')} Then rest.</p>`,
    );
    const res = resolveFresh(anchorSet);
    expect(res.status).toBe('changed');
  });

  it('a long sentence with one corrected figure is an edit, not a sibling', () => {
    const long =
      'In the 2019 cohort of adult patients enrolled across all participating sites, the median follow-up period was 14 months before the first interim analysis.';
    expect(long.length).toBeGreaterThan(120);
    setBody(`<p>Intro text. ${long} Then rest.</p>`);
    const { anchorSet } = capture(long);
    setBody(`<p>Intro text. ${long.replace('14 months', '16 months')} Then rest.</p>`);
    const res = resolveFresh(anchorSet);
    expect(res.status).toBe('changed');
    expect(res.range!.toString()).toContain('16 months');
  });

  it('does not make an exact copy ambiguous: a verbatim quote is still found', () => {
    setBody(`<p>Intro text. ${dose} Then rest.</p>`);
    const { anchorSet } = capture(dose);
    setBody(`<p>Banner.</p><p>Intro text. ${dose} Then rest.</p>`);
    expect(resolveFresh(anchorSet).status).toBe('resolved');
  });
});

describe('quote spanning a block boundary', () => {
  const p1 = '<p>Photosynthesis converts light energy into chemical energy in plants.</p>';
  const p2 = '<p>The reaction takes place inside the chloroplast of the leaf cells.</p>';
  const quote = 'chemical energy in plants.The reaction takes place inside the chloroplast';

  // F3: a dynamically inserted ad label between the two paragraphs used to orphan a two-sentence
  // highlight although both halves are still verbatim on the page.
  it('survives a label inserted between the paragraphs of a saved two-paragraph quote', () => {
    setBody(p1 + p2);
    const { anchorSet } = capture(quote);
    setBody(`${p1}<div>Advertisement</div>${p2}`);
    const res = resolveFresh(anchorSet);
    expect(res.status).toBe('changed');
    expect(res.method).toBe('fuzzy');
    expect(res.range).not.toBeNull();
    expect(res.confidence).toBeGreaterThanOrEqual(0.85);
    expect(res.confidence).toBeLessThan(1);
    expect(res.range!.toString()).toContain('Advertisement');
    expect(res.range!.toString().startsWith('chemical energy in plants.')).toBe(true);
    expect(res.range!.toString().endsWith('inside the chloroplast')).toBe(true);
  });

  it('is never painted when the head or the tail occurs twice', () => {
    setBody(p1 + p2);
    const { anchorSet } = capture(quote);
    setBody(`${p1}<div>Advertisement</div>${p2}<hr>${p1}<div>Advertisement</div>${p2}`);
    const res = resolveFresh(anchorSet);
    expect(res.range).toBeNull();
    expect(res.status).toBe('ambiguous');
  });

  it('is orphaned when the inserted block is far larger than any label', () => {
    setBody(p1 + p2);
    const { anchorSet } = capture(quote);
    setBody(`${p1}<div>${'sponsored content '.repeat(40)}</div>${p2}`);
    const res = resolveFresh(anchorSet);
    expect(res.status).toBe('orphaned');
    expect(res.range).toBeNull();
  });

  it('keeps the 0.85 gate: verbatim head and tail around a rewritten middle are orphaned', () => {
    const head = 'Mitochondria are organelles that';
    const tail = 'and the electron transport chain.';
    const middle = ' produce most of the usable chemical energy of the cell through oxidative ';
    setBody(`<p>${head}${middle}${tail}</p>`);
    const { anchorSet } = capture(head + middle + tail);
    const rewritten = ' are small bean shaped structures that nobody should confuse with plastid ';
    expect(rewritten.length).toBe(middle.length);
    setBody(`<p>${head}${rewritten}${tail}</p>`);
    const res = resolveFresh(anchorSet);
    expect(res.status).toBe('orphaned');
    expect(res.range).toBeNull();
  });

  it('does not split a short quote (head and tail would carry too little evidence)', () => {
    const a = '<p>The mitochondrion makes ATP.</p>';
    const b = '<p>The chloroplast makes sugar.</p>';
    setBody(a + b);
    const { anchorSet } = capture('makes ATP.The chloroplast makes sugar.');
    expect(anchorSet.textQuote.exact.length).toBeLessThan(64);
    setBody(`${a}<div>Advertisement</div>${b}`);
    const res = resolveFresh(anchorSet);
    expect(res.status).toBe('orphaned');
    expect(res.range).toBeNull();
  });

  it('a nested quote and its enclosing quote are both recovered (containment is not a collision)', () => {
    setBody(p1 + p2);
    const inner = capture(quote);
    const outer = capture(
      'Photosynthesis converts light energy into chemical energy in plants.The reaction takes place inside the chloroplast of the leaf cells.',
    );
    setBody(`${p1}<div>Advertisement</div>${p2}`);
    const out = resolveMany(
      [
        { id: 'inner', anchorSet: inner.anchorSet },
        { id: 'outer', anchorSet: outer.anchorSet },
      ],
      buildTextStream(),
    );
    expect(out.get('inner')!.status).toBe('changed');
    expect(out.get('outer')!.status).toBe('changed');
    const o = out.get('outer')!.range!;
    const i = out.get('inner')!.range!;
    expect(o.compareBoundaryPoints(Range.START_TO_START, i)).toBeLessThanOrEqual(0);
    expect(o.compareBoundaryPoints(Range.END_TO_END, i)).toBeGreaterThanOrEqual(0);
  });
});

describe('headingContext is built by the stream rules, not from raw textContent', () => {
  // F4: the heading search walks raw DOM; editor drafts, nested script/SVG text and permalink glyphs
  // used to reach IndexedDB (and every export) as the highlight's section title.
  it('does not store a heading that lives inside an editor', () => {
    setBody(
      '<div contenteditable="true"><h2>MY PRIVATE DRAFT TITLE</h2><p>draft words</p></div>' +
        '<article><p>Public quoted sentence that is long enough to anchor.</p></article>',
    );
    const { headingContext } = capture('Public quoted sentence');
    expect(headingContext ?? '').not.toContain('PRIVATE');
    expect(headingContext).toBeNull();
  });

  it('does not include script text or an SVG <title> from inside the heading', () => {
    setBody(
      '<h2>Usage<svg><title>link icon</title></svg><script>var token = "s3cr3t";</script></h2>' +
        '<p>Quoted sentence that follows the heading in the document order.</p>',
    );
    const { headingContext } = capture('Quoted sentence');
    expect(headingContext).toBe('Usage');
  });

  it('does not include a Sphinx/MkDocs permalink glyph', () => {
    setBody(
      '<h2 id="usage">Usage<a class="headerlink" href="#usage" title="Permalink">¶</a></h2>' +
        '<p>Quoted sentence that follows the heading in the document order.</p>',
    );
    const { headingContext } = capture('Quoted sentence');
    expect(headingContext).toBe('Usage');
  });
});

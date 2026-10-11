/**
 * Adversarial anchoring probes (review lens: anchoring correctness).
 *
 * Every test states the behaviour ADR-004 / CLAUDE.md promise ("never silently pick wrong text";
 * "lost although the quote is unambiguously present" is a defect). `it.fails` marks a probe that
 * reproduces a proven defect today: the suite stays green, and the probe turns red the moment the
 * defect is fixed so it can be flipped to a plain `it`.
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

describe('occurrence cap scores the FIRST 200 copies, not the ones near the stored position', () => {
  const sentence = 'The powerhouse of the cell and its many roles in energy production.';
  const filler = Array.from(
    { length: 300 },
    (_, i) => `<p>Filler paragraph ${i} mentions a cell in passing.</p>`,
  ).join('');

  // F1: the real copy (301st "cell") is never a candidate; an earlier look-alike wins and is painted.
  it.fails('never paints an earlier look-alike when the real copy is beyond the cap', () => {
    setBody(`<p>noise 1</p><p>Abstract. ${sentence}</p>${filler}<p>Body. ${sentence}</p>`);
    const { anchorSet } = capture('cell', 301);
    expect(anchorSet.textQuote.prefix).toContain('Body');
    // The page changes slightly elsewhere (counter, ad, timestamp): the byte-identical shortcut is gone.
    setBody(`<p>noise 12</p><p>Abstract. ${sentence}</p>${filler}<p>Body. ${sentence}</p>`);
    const res = resolveFresh(anchorSet);
    // Correct: the Body copy, or at worst "ambiguous". Wrong: painted inside the Abstract.
    expect(res.range === null || ownerText(res).startsWith('Body.')).toBe(true);
  });

  // F1b: no look-alike at all, context intact (64 chars agree), still lost.
  it.fails('finds a quote with intact context even when it is the 250th of 300 copies', () => {
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
  // F2: step 3 was deleted; "Step 4" differs by one character and is painted as the user's highlight.
  it.fails('a deleted list item is not replaced by its nearly identical neighbour', () => {
    setBody(
      '<ul><li>Step 3: Press the red button now.</li><li>Step 4: Press the red button now.</li><li>Step 5: Release it.</li></ul>',
    );
    const { anchorSet } = capture('Step 3: Press the red button now.');
    setBody('<ul><li>Step 4: Press the red button now.</li><li>Step 5: Release it.</li></ul>');
    const res = resolveFresh(anchorSet);
    expect(res.range).toBeNull(); // orphaned or ambiguous; never "changed" on Step 4
  });

  // F2b: both steps were highlighted; deleting step 3 makes its highlight a second copy of step 4's.
  it.fails('a highlight is not re-bound onto text another saved highlight already owns', () => {
    setBody(
      '<ul><li>Step 3: Press the red button now.</li><li>Step 4: Press the red button now.</li><li>Step 5: Release it.</li></ul>',
    );
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
});

describe('quote spanning a block boundary', () => {
  // F3: a dynamically inserted ad label between the two paragraphs orphans a two-sentence highlight
  // although both halves are still verbatim on the page.
  it.fails(
    'survives a label inserted between the paragraphs of a saved two-paragraph quote',
    () => {
      const p1 = '<p>Photosynthesis converts light energy into chemical energy in plants.</p>';
      const p2 = '<p>The reaction takes place inside the chloroplast of the leaf cells.</p>';
      setBody(p1 + p2);
      const { anchorSet } = capture(
        'chemical energy in plants.The reaction takes place inside the chloroplast',
      );
      setBody(`${p1}<div>Advertisement</div>${p2}`);
      const res = resolveFresh(anchorSet);
      expect(res.range).not.toBeNull();
    },
  );
});

describe('headingContext is not built from the text stream', () => {
  // F4: the heading search walks raw DOM and reads textContent: editor drafts, nested script/SVG
  // text and permalink glyphs reach IndexedDB (and every export) as the highlight's section title.
  it.fails('does not store a heading that lives inside an editor', () => {
    setBody(
      '<div contenteditable="true"><h2>MY PRIVATE DRAFT TITLE</h2><p>draft words</p></div>' +
        '<article><p>Public quoted sentence that is long enough to anchor.</p></article>',
    );
    const { headingContext } = capture('Public quoted sentence');
    expect(headingContext ?? '').not.toContain('PRIVATE');
  });

  it.fails('does not include script text or an SVG <title> from inside the heading', () => {
    setBody(
      '<h2>Usage<svg><title>link icon</title></svg><script>var token = "s3cr3t";</script></h2>' +
        '<p>Quoted sentence that follows the heading in the document order.</p>',
    );
    const { headingContext } = capture('Quoted sentence');
    expect(headingContext).toBe('Usage');
  });

  it.fails('does not include a Sphinx/MkDocs permalink glyph', () => {
    setBody(
      '<h2 id="usage">Usage<a class="headerlink" href="#usage" title="Permalink">¶</a></h2>' +
        '<p>Quoted sentence that follows the heading in the document order.</p>',
    );
    const { headingContext } = capture('Quoted sentence');
    expect(headingContext).toBe('Usage');
  });
});

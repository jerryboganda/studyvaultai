import { beforeAll, describe, expect, it } from 'vitest';
import { captureAnchor } from './capture';
import { resolveMany } from './resolve';
import { buildTextStream, streamRangeToDomRange } from './textStream';
import { prng } from './testUtils';
import type { HtmlAnchorSet } from '@shared';

// ~1 MB of visible text in ~4,500 paragraphs with inline markup and headings.
const PARAGRAPHS = 4500;

function pseudoWord(rand: () => number): string {
  const len = 3 + Math.floor(rand() * 8);
  let w = '';
  for (let i = 0; i < len; i++) w += String.fromCharCode(97 + Math.floor(rand() * 26));
  return w;
}

function buildHtml(): string {
  const rand = prng(20261011);
  const vocabulary = Array.from({ length: 6000 }, () => pseudoWord(rand));
  const sentence = (n: number): string =>
    Array.from({ length: n }, () => vocabulary[Math.floor(rand() * vocabulary.length)]).join(' ');
  const parts: string[] = [];
  for (let i = 0; i < PARAGRAPHS; i++) {
    if (i % 25 === 0) parts.push(`<h2>Section ${i / 25}: ${sentence(3)}</h2>`);
    parts.push(
      `<p>${sentence(8)} <strong>${sentence(3)}</strong> ${sentence(10)} <a href="#${i}">${sentence(2)}</a> ${sentence(12)}.</p>`,
    );
  }
  return parts.join('\n');
}

let html = '';
let built = 0;

beforeAll(() => {
  html = buildHtml();
  const t0 = performance.now();
  document.body.innerHTML = html;
  built = performance.now() - t0;
}, 120_000);

describe('performance on a ~1 MB document (jsdom)', () => {
  it('builds the stream and resolves 200 anchors well inside the budget', () => {
    const t0 = performance.now();
    const stream = buildTextStream();
    const tStream = performance.now() - t0;
    expect(stream.text.length).toBeGreaterThan(900_000);

    // Capture 200 quotes spread over the document (not part of the timed restore path).
    const rand = prng(77);
    const anchors: { id: string; anchorSet: HtmlAnchorSet }[] = [];
    const tCap0 = performance.now();
    for (let i = 0; i < 200; i++) {
      const length = 40 + Math.floor(rand() * 160);
      const start = Math.floor(rand() * (stream.text.length - length - 1));
      const range = streamRangeToDomRange(stream, start, start + length);
      expect(range).not.toBeNull();
      const result = captureAnchor(range!, range!.toString(), stream);
      if ('error' in result) continue;
      anchors.push({ id: `h${i}`, anchorSet: result.anchorSet });
    }
    const tCapture = performance.now() - tCap0;
    expect(anchors.length).toBeGreaterThan(190);

    // Restore: rebuild the stream and resolve everything, as on a page reload.
    const r0 = performance.now();
    const fresh = buildTextStream();
    const resolved = resolveMany(anchors, fresh);
    const tRestore = performance.now() - r0;

    let ok = 0;
    for (const { id } of anchors) if (resolved.get(id)!.status === 'resolved') ok++;
    expect(ok).toBe(anchors.length);

    // Same, but the page changed above every quote: signature differs, quote search does the work.
    const first = document.querySelector('p')!;
    const banner = document.createElement('p');
    banner.textContent = 'A new banner paragraph inserted above all content.';
    first.before(banner);
    const m0 = performance.now();
    const shifted = buildTextStream();
    const shiftedResults = resolveMany(anchors, shifted);
    const tShifted = performance.now() - m0;
    banner.remove();
    let shiftedOk = 0;
    for (const { id } of anchors) if (shiftedResults.get(id)!.status === 'resolved') shiftedOk++;
    expect(shiftedOk).toBe(anchors.length);

    console.log(
      `perf(jsdom): text=${stream.text.length} chars, segments=${stream.segments.length}, ` +
        `dom-parse=${built.toFixed(0)}ms, buildTextStream=${tStream.toFixed(0)}ms, ` +
        `capture x${anchors.length}=${tCapture.toFixed(0)}ms, ` +
        `restore(stream+${anchors.length} resolutions)=${tRestore.toFixed(0)}ms, ` +
        `restore after edit=${tShifted.toFixed(0)}ms`,
    );
    expect(tRestore).toBeLessThan(2000);
    expect(tShifted).toBeLessThan(2000);
  }, 120_000);

  it('a page rewritten wholesale (all 200 anchors orphaned) stays bounded', () => {
    const stream = buildTextStream();
    const rand = prng(5);
    const anchors: { id: string; anchorSet: HtmlAnchorSet }[] = [];
    for (let i = 0; i < 200; i++) {
      const length = 60 + Math.floor(rand() * 200);
      const start = Math.floor(rand() * (stream.text.length - length - 1));
      const range = streamRangeToDomRange(stream, start, start + length)!;
      const result = captureAnchor(range, range.toString(), stream);
      if (!('error' in result)) anchors.push({ id: `o${i}`, anchorSet: result.anchorSet });
    }
    // Replace the whole page with unrelated text of similar size.
    const rand2 = prng(999);
    const filler = Array.from({ length: 3000 }, () => {
      let s = '';
      for (let i = 0; i < 40; i++) s += pseudoWord(rand2) + ' ';
      return `<p>${s}</p>`;
    }).join('');
    const saved = document.body.innerHTML;
    document.body.innerHTML = filler;

    const t0 = performance.now();
    const results = resolveMany(anchors, buildTextStream());
    const elapsed = performance.now() - t0;
    document.body.innerHTML = saved;

    let orphaned = 0;
    for (const { id } of anchors) {
      const r = results.get(id)!;
      expect(r.range).toBeNull();
      if (r.status === 'orphaned') orphaned++;
    }
    console.log(
      `perf(jsdom): ${anchors.length} orphan resolutions on a rewritten page = ${elapsed.toFixed(0)}ms`,
    );
    expect(orphaned).toBe(anchors.length);
    expect(elapsed).toBeLessThan(8000);
  }, 120_000);
});

// @vitest-environment node
// The link rules (links.ts). The geometry is checked against pdf.js's own viewport transform, and the
// whole path (annotation -> destination -> PageLink) runs through the real pdf.js on a generated PDF.
import { afterEach, describe, expect, it } from 'vitest';
import type { PdfRect } from '@shared';
import { openPdf, type PdfDocument } from './engine';
import { rotateRect } from './geometry';
import {
  DENSE_PAGE_LINKS,
  MAX_BACK_ENTRIES,
  MAX_LINKS_PER_PAGE,
  MAX_LINK_URL_LENGTH,
  buildPageLinks,
  destinationPoint,
  hitTest,
  orderByLines,
  popBack,
  pushBack,
  userRectToFrame,
  vetExternalUrl,
  type LinkContext,
  type RawAnnotation,
  type ViewPosition,
} from './links';
import { buildPdf, type FixturePage } from './testing/pdfWriter';

const open: PdfDocument[] = [];
const load = async (pages: FixturePage[], opts?: Parameters<typeof buildPdf>[1]) => {
  const doc = await openPdf(buildPdf(pages, opts));
  open.push(doc);
  return doc;
};
afterEach(async () => {
  await Promise.all(open.splice(0).map((d) => d.destroy()));
});

describe('userRectToFrame: the same frame and rotation as pdf.js', () => {
  // A rectangle that is not square and not centred, on a page that is not square.
  const rects: Array<[number, number, number, number]> = [
    [20, 30, 120, 60],
    [200, 400, 290, 480],
    [0, 0, 300, 500],
  ];

  for (const own of [0, 90] as const) {
    for (const reader of [0, 90, 180, 270]) {
      it(`page /Rotate ${own}, reader rotation ${reader}, at several scales`, async () => {
        const rotation = (own + reader) % 360;
        const doc = await load([{ width: 300, height: 500, rotate: own }]);
        const page = await doc.getPage(1);
        for (const scale of [0.5, 1.5, 2]) {
          const vp = page.getViewport({ scale, rotation });
          for (const rect of rects) {
            const frame = userRectToFrame(rect, page.view)!;
            const shown = rotateRect(frame, rotation);
            // Two opposite corners through pdf.js's own transform (the rectangle method was dropped).
            const [x1, y1] = vp.convertToViewportPoint(rect[0], rect[1]) as [number, number];
            const [x2, y2] = vp.convertToViewportPoint(rect[2], rect[3]) as [number, number];
            expect(shown.x).toBeCloseTo(Math.min(x1, x2) / vp.width, 6);
            expect(shown.y).toBeCloseTo(Math.min(y1, y2) / vp.height, 6);
            expect(shown.w).toBeCloseTo(Math.abs(x2 - x1) / vp.width, 6);
            expect(shown.h).toBeCloseTo(Math.abs(y2 - y1) / vp.height, 6);
          }
        }
      });
    }
  }

  it('measures from the page box, not from the origin', () => {
    // view [10 20 310 520]: 300 x 500; a 30 x 50 rectangle whose lower-left corner is 40 / 70 into it.
    const r = userRectToFrame([50, 90, 80, 140], [10, 20, 310, 520])!;
    expect(r.x).toBeCloseTo(40 / 300, 9);
    expect(r.w).toBeCloseTo(30 / 300, 9);
    expect(r.y).toBeCloseTo((520 - 140) / 500, 9);
    expect(r.h).toBeCloseTo(50 / 500, 9);
  });

  it('accepts corners in either order, cuts to the page, and rejects what has no area', () => {
    expect(userRectToFrame([80, 140, 50, 90], [0, 0, 300, 500])).toEqual(
      userRectToFrame([50, 90, 80, 140], [0, 0, 300, 500]),
    );
    const cut = userRectToFrame([-50, -50, 100, 100], [0, 0, 300, 500])!;
    expect(cut.x).toBe(0);
    expect(cut.w).toBeCloseTo(100 / 300, 9);
    expect(cut.y + cut.h).toBe(1);
    expect(userRectToFrame([10, 10, 10, 50], [0, 0, 300, 500])).toBeNull(); // no width
    expect(userRectToFrame([400, 10, 500, 50], [0, 0, 300, 500])).toBeNull(); // off the page
    expect(userRectToFrame([Number.NaN, 0, 5, 5], [0, 0, 300, 500])).toBeNull();
  });

  it('names a destination point in the same frame (top-left origin)', () => {
    expect(destinationPoint([0, 0, 300, 500], 75, 400)).toEqual({ x: 0.25, y: 0.2 });
    expect(destinationPoint([0, 0, 300, 500], null, null)).toEqual({ x: 0, y: 0 });
    expect(destinationPoint([0, 0, 300, 500], -10, 900)).toEqual({ x: 0, y: 0 });
  });
});

describe('vetExternalUrl: what may be offered for opening', () => {
  const ok: Array<[string, string]> = [
    ['https://example.org/a?b=c#d', 'https://example.org/a?b=c#d'],
    ['http://example.org', 'http://example.org/'],
    ['HTTPS://EXAMPLE.ORG/Path', 'https://example.org/Path'],
    ['https://example.org:8443/x', 'https://example.org:8443/x'],
    ['https://münchen.example/', 'https://xn--mnchen-3ya.example/'],
  ];
  for (const [raw, url] of ok) {
    it(`opens ${raw}`, () => {
      const v = vetExternalUrl(raw);
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.url).toBe(url);
    });
  }

  it('reports the site as it is contacted (internationalised names as ASCII)', () => {
    const v = vetExternalUrl('https://münchen.example:8443/x');
    expect(v).toMatchObject({
      ok: true,
      host: 'xn--mnchen-3ya.example:8443',
      origin: 'https://xn--mnchen-3ya.example:8443',
    });
  });

  const refused: Array<[string, string, string | null]> = [
    ['javascript:alert(1)', 'javascript', 'scheme'],
    ['JaVaScRiPt:alert(1)', 'javascript', 'scheme'],
    ['  javascript:alert(1)', 'javascript', 'scheme'],
    ['java\nscript:alert(1)', 'javascript', 'scheme'],
    ['data:text/html,<script>alert(1)</script>', 'data', 'scheme'],
    ['file:///C:/Windows/system32/calc.exe', 'file', 'scheme'],
    ['chrome://settings', 'chrome', 'scheme'],
    [
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/pdf-reader.html',
      'chrome-extension',
      'scheme',
    ],
    ['blob:https://example.org/3b1c', 'blob', 'scheme'],
    ['about:blank', 'about', 'scheme'],
    ['ftp://example.org/file', 'ftp', 'scheme'],
    ['mailto:someone@example.org', 'mailto', 'scheme'],
    ['tel:+15555550100', 'tel', 'scheme'],
    ['C:\\Windows\\system32\\calc.exe', 'c', 'scheme'],
  ];
  for (const [raw, scheme] of refused) {
    it(`refuses ${JSON.stringify(raw)} as "${scheme}:"`, () => {
      const v = vetExternalUrl(raw);
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.scheme).toBe(scheme);
        expect(v.reason).toContain(`"${scheme}:"`);
      }
    });
  }

  const notAddresses = [
    '',
    'example.org/page',
    '//example.org/page',
    '/relative/path.html',
    'page2.html',
    'https://',
    'https://exa mple.org',
    'https://example.org:99999/',
  ];
  for (const raw of notAddresses) {
    it(`refuses ${JSON.stringify(raw)} as not a full web address`, () => {
      const v = vetExternalUrl(raw);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.scheme).toBeNull();
    });
  }

  it('refuses an address with a user name or password (the host would not be the one shown first)', () => {
    for (const raw of ['https://user:pw@example.org/', 'https://example.org@evil.example/']) {
      const v = vetExternalUrl(raw);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toContain('user name or password');
    }
  });

  it('refuses an address longer than the cap, and accepts one exactly at it', () => {
    const base = 'https://example.org/';
    const at = base + 'a'.repeat(MAX_LINK_URL_LENGTH - base.length);
    expect(at).toHaveLength(MAX_LINK_URL_LENGTH);
    expect(vetExternalUrl(at).ok).toBe(true);
    const over = vetExternalUrl(at + 'a');
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toContain('longer than 2,048');
  });
});

describe('back stack', () => {
  const at = (page: number, frac = 0): ViewPosition => ({ page, frac });

  it('returns positions last in, first out', () => {
    let stack: ViewPosition[] = [];
    stack = pushBack(stack, at(1, 0.2));
    stack = pushBack(stack, at(5, 0.5));
    const first = popBack(stack);
    expect(first.to).toEqual(at(5, 0.5));
    const second = popBack(first.stack);
    expect(second.to).toEqual(at(1, 0.2));
    expect(popBack(second.stack).to).toBeNull();
  });

  it('does not stack the place that is already on top, and keeps the newest MAX entries', () => {
    let stack = pushBack([], at(3, 0.5));
    stack = pushBack(stack, at(3, 0.505));
    expect(stack).toHaveLength(1);
    for (let i = 1; i <= MAX_BACK_ENTRIES + 10; i++) stack = pushBack(stack, at(i, 0.1));
    expect(stack).toHaveLength(MAX_BACK_ENTRIES);
    expect(stack[stack.length - 1]).toEqual(at(MAX_BACK_ENTRIES + 10, 0.1));
    expect(stack[0]!.page).toBe(11);
  });

  it('does not change the stack it is given', () => {
    const base = [at(1)];
    pushBack(base, at(2));
    popBack(base);
    expect(base).toEqual([at(1)]);
  });
});

describe('order and hit test', () => {
  const box = (x: number, y: number, w = 0.1, h = 0.02): PdfRect => ({ x, y, w, h });

  it('reads top to bottom and, within a line, left to right', () => {
    const items = [
      { id: 'c', b: box(0.1, 0.3) },
      { id: 'b', b: box(0.5, 0.101) }, // same line as `a`, slightly lower
      { id: 'a', b: box(0.1, 0.1) },
      { id: 'd', b: box(0.7, 0.3) },
    ];
    expect(orderByLines(items, (i) => i.b).map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('hits the topmost box and misses outside every box', () => {
    const boxes = [
      [box(0.1, 0.1, 0.5, 0.1)],
      [box(0.3, 0.1, 0.5, 0.1)],
      [box(0.1, 0.5), box(0.5, 0.5)],
    ];
    expect(hitTest(boxes, 0.2, 0.15)).toBe(0);
    expect(hitTest(boxes, 0.4, 0.15)).toBe(1); // both hold it: the later one is on top
    expect(hitTest(boxes, 0.55, 0.52)).toBe(2); // any rectangle of a wrapped link
    expect(hitTest(boxes, 0.35, 0.52)).toBe(-1);
  });
});

describe('buildPageLinks: classification (injected resolver)', () => {
  const view = [0, 0, 300, 500];
  const ctx = (over: Partial<LinkContext> = {}): LinkContext => ({
    view,
    rotate: 0,
    pageNumber: 4,
    pageCount: 10,
    resolve: async (dest) =>
      dest === 'gone'
        ? { pageNumber: null, top: null }
        : dest === 'boom'
          ? Promise.reject(new Error('worker'))
          : { pageNumber: 7, top: 400, left: 50 },
    ...over,
  });
  const link = (extra: RawAnnotation): RawAnnotation => ({
    subtype: 'Link',
    rect: [10, 10, 100, 30],
    ...extra,
  });
  const build = async (raw: RawAnnotation[], over?: Partial<LinkContext>) =>
    buildPageLinks(raw, ctx(over));
  const targetOf = async (a: RawAnnotation) => (await build([link(a)])).links[0]?.target;

  it('names a destination, with the label a screen reader says', async () => {
    const { links } = await build([link({ dest: 'chapter-2' })]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      label: 'Link to page 7',
      target: { kind: 'page', pageNumber: 7, left: 50, top: 400 },
    });
  });

  it('offers an https address as external, with its host', async () => {
    const { links } = await build([
      link({ url: 'https://example.org/x', unsafeUrl: 'https://example.org/x' }),
    ]);
    expect(links[0]).toMatchObject({
      label: 'External link to example.org',
      target: { kind: 'external', url: 'https://example.org/x', host: 'example.org' },
    });
  });

  it('refuses a script address that pdf.js reports only as unsafeUrl', async () => {
    const t = await targetOf({ unsafeUrl: 'javascript:alert(1)' });
    expect(t).toMatchObject({ kind: 'refused' });
    expect(t && t.kind === 'refused' && t.reason).toContain('"javascript:"');
  });

  it('refuses addresses pdf.js accepts but the reader does not (mailto, ftp)', async () => {
    for (const url of ['mailto:a@example.org', 'ftp://example.org/f']) {
      expect((await targetOf({ url, unsafeUrl: url }))?.kind).toBe('refused');
    }
  });

  it('refuses Launch, GoToR and script-recovered addresses (pdf.js sets newWindow for them)', async () => {
    const t = await targetOf({
      url: 'https://example.org/',
      unsafeUrl: 'https://example.org/',
      newWindow: true,
    });
    expect(t).toMatchObject({ kind: 'refused' });
    expect((await targetOf({ unsafeUrl: 'other.pdf', newWindow: false }))?.kind).toBe('refused');
  });

  it('refuses attachments, form resets and layer toggles', async () => {
    expect((await targetOf({ attachment: { filename: 'a.exe' } }))?.kind).toBe('refused');
    expect((await targetOf({ resetForm: { fields: [], refs: [], include: true } }))?.kind).toBe(
      'refused',
    );
    expect((await targetOf({ setOCGState: { state: ['ON'], preserveRB: true } }))?.kind).toBe(
      'refused',
    );
  });

  it('follows the four page actions and refuses the others by name', async () => {
    expect(await targetOf({ action: 'NextPage' })).toMatchObject({ kind: 'page', pageNumber: 5 });
    expect(await targetOf({ action: 'PrevPage' })).toMatchObject({ kind: 'page', pageNumber: 3 });
    expect(await targetOf({ action: 'FirstPage' })).toMatchObject({ kind: 'page', pageNumber: 1 });
    expect(await targetOf({ action: 'LastPage' })).toMatchObject({ kind: 'page', pageNumber: 10 });
    const print = await targetOf({ action: 'Print' });
    expect(print).toMatchObject({ kind: 'refused' });
    expect(print && print.kind === 'refused' && print.reason).toContain('"Print"');
  });

  it('refuses a destination that is not in the file, or cannot be read', async () => {
    expect((await targetOf({ dest: 'gone' }))?.kind).toBe('refused');
    expect((await targetOf({ dest: 'boom' }))?.kind).toBe('refused');
  });

  it('skips what is not a link, has no area, or has no action pdf.js understands', async () => {
    const { links } = await build([
      { subtype: 'Text', rect: [10, 10, 50, 50], dest: 'x' },
      link({ rect: [10, 10, 10, 30], dest: 'x' }),
      link({ rect: [500, 500, 600, 600], dest: 'x' }),
      link({}),
      link({ dest: 'x' }),
    ]);
    expect(links).toHaveLength(1);
  });

  it('uses one rectangle per quadrilateral of a wrapped link', async () => {
    // pdf.js stores a quad as [minX, maxY, maxX, maxY, minX, minY, maxX, minY].
    const quads = new Float32Array([
      10, 60, 100, 60, 10, 40, 100, 40, 10, 30, 50, 30, 10, 10, 50, 10,
    ]);
    const { links } = await build([
      link({ rect: [10, 10, 100, 60], quadPoints: quads, dest: 'x' }),
    ]);
    expect(links[0]!.rects).toHaveLength(2);
    expect(links[0]!.rects[0]!.w).toBeCloseTo(90 / 300, 6);
    expect(links[0]!.rects[1]!.w).toBeCloseTo(40 / 300, 6);
  });

  it('keeps MAX_LINKS_PER_PAGE links and counts the rest', async () => {
    const many = Array.from({ length: MAX_LINKS_PER_PAGE + 7 }, (_, i) =>
      link({ rect: [10, 10 + (i % 400), 100, 30 + (i % 400)], dest: 'x' }),
    );
    const out = await build(many);
    expect(out.links).toHaveLength(MAX_LINKS_PER_PAGE);
    expect(out.omitted).toBe(7);
  });

  it('copes with data that is not what pdf.js promises', async () => {
    expect(await build(null as never)).toEqual({ links: [], omitted: 0 });
    expect(await build([null, 3, 'x', {}] as never)).toEqual({ links: [], omitted: 0 });
  });
});

describe('through the real pdf.js', () => {
  const pages: FixturePage[] = [
    {
      width: 300,
      height: 500,
      texts: [{ x: 20, y: 440, text: 'links here' }],
      links: [
        { rect: [20, 436, 120, 452], goTo: { page: 3, fromTop: 100 } },
        { rect: [20, 396, 120, 412], named: 'glossary' },
        { rect: [20, 356, 120, 372], uri: 'https://example.org/a?b=1' },
        { rect: [20, 316, 120, 332], uri: 'javascript:alert(1)' },
        { rect: [20, 276, 120, 292], uri: 'mailto:a@example.org' },
        { rect: [20, 236, 120, 252], action: '/S /Named /N /Print' },
        { rect: [20, 196, 120, 212], action: '/S /Launch /F (calc.exe)' },
        { rect: [20, 156, 120, 172], named: 'nowhere' },
      ],
    },
    { width: 300, height: 500, texts: [{ x: 20, y: 440, text: 'second' }] },
    { width: 300, height: 500, texts: [{ x: 20, y: 440, text: 'third' }] },
  ];

  it('reads, resolves and classifies the annotations of a page, top of the page first', async () => {
    const doc = await load(pages, { namedDests: { glossary: { page: 2, fromTop: 200 } } });
    const { links, omitted } = await doc.getLinks(1);
    expect(omitted).toBe(0);
    const refused = 'Link that StudyVault will not open';
    expect(links.map((l) => [l.target.kind, l.label])).toEqual([
      ['page', 'Link to page 3'],
      ['page', 'Link to page 2'],
      ['external', 'External link to example.org'],
      ['refused', refused],
      ['refused', refused],
      ['refused', refused],
      ['refused', refused],
      ['refused', refused],
    ]);
    expect(links[0]!.target).toMatchObject({ kind: 'page', pageNumber: 3, left: 72, top: 400 });
    expect(links[1]!.target).toMatchObject({ kind: 'page', pageNumber: 2, left: 72, top: 300 });
    expect(links[2]!.target).toMatchObject({ kind: 'external', url: 'https://example.org/a?b=1' });
    const reasons = links.slice(3).map((l) => (l.target.kind === 'refused' ? l.target.reason : ''));
    expect(reasons[0]).toContain('"javascript:"');
    expect(reasons[1]).toContain('"mailto:"');
    expect(reasons[2]).toContain('"Print"');
    // A Launch of a file name reaches the reader as an address that is not absolute.
    expect(reasons[3]).toMatch(/not a full web address/);
    expect(reasons[4]).toMatch(/not in this PDF/); // a named destination the file does not have
  });

  it('caches a page and gives pages without links an empty list', async () => {
    const doc = await load(pages, { namedDests: { glossary: { page: 2, fromTop: 200 } } });
    expect(await doc.getLinks(1)).toBe(await doc.getLinks(1));
    expect(await doc.getLinks(2)).toEqual({ links: [], omitted: 0 });
  });

  it('puts a page with more than DENSE_PAGE_LINKS links over the tab-order threshold', async () => {
    const links = Array.from({ length: DENSE_PAGE_LINKS + 5 }, (_, i) => ({
      rect: [
        10 + (i % 8) * 30,
        10 + Math.floor(i / 8) * 20,
        36 + (i % 8) * 30,
        26 + Math.floor(i / 8) * 20,
      ] as [number, number, number, number],
      uri: `https://example.org/${i}`,
    }));
    const doc = await load([{ width: 300, height: 500, links }]);
    const got = await doc.getLinks(1);
    expect(got.links).toHaveLength(DENSE_PAGE_LINKS + 5);
    expect(got.links.every((l) => l.target.kind === 'external')).toBe(true);
  });
});

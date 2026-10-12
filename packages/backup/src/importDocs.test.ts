import { afterEach, describe, expect, it, vi } from 'vitest';
import { strToU8 } from 'fflate';
import { exportAnki } from './anki';
import { exportDataset } from './exportData';
import { ZipSink } from './format';
import { importAnkiHighlights, importDocument } from './importDocs';
import { looksLikeAnkiText } from './importExternal';
import { subtle } from './testkit';

const opts = { subtle } as const;
const MiB = 1024 * 1024;

/** A ZIP of text/binary entries, built with the same writer the backups use. */
function zip(files: Record<string, string | Uint8Array>, level: 0 | 6 = 6): Uint8Array {
  const sink = new ZipSink(new Date(Date.UTC(2026, 0, 1)));
  for (const [name, data] of Object.entries(files)) {
    sink.add(name, typeof data === 'string' ? strToU8(data) : data, level);
  }
  return sink.finish();
}

/** Overwrite the uncompressed size the central directory declares for one entry. */
function declareSize(bytes: Uint8Array, entry: string, size: number): Uint8Array {
  const out = bytes.slice();
  const dv = new DataView(out.buffer);
  let eocd = out.length - 22;
  while (dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  let p = dv.getUint32(eocd + 16, true);
  for (let n = dv.getUint16(eocd + 10, true); n > 0; n--) {
    const nameLen = dv.getUint16(p + 28, true);
    if (new TextDecoder().decode(out.subarray(p + 46, p + 46 + nameLen)) === entry) {
      dv.setUint32(p + 24, size, true);
      return out;
    }
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  throw new Error(`no entry ${entry}`);
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (...runs: string[]) => `<w:p>${runs.map(run).join('')}</w:p>`;
const docxXml = (body: string) =>
  `${XML}<w:document xmlns:w="${W}" xmlns:mc="${MC}"><w:body>${body}</w:body></w:document>`;
const docx = (body: string, extra: Record<string, string | Uint8Array> = {}) =>
  zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': docxXml(body), ...extra });

const aPara = (...runs: string[]) =>
  `<a:p>${runs.map((t) => `<a:r><a:t>${t}</a:t></a:r>`).join('')}</a:p>`;
const shape = (paras: string, ph?: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="1" name="s"/><p:cNvSpPr/><p:nvPr>${
    ph ? `<p:ph type="${ph}"/>` : ''
  }</p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/>${paras}</p:txBody></p:sp>`;
const slideXml = (...shapes: string[]) =>
  `${XML}<p:sld xmlns:a="${A}" xmlns:p="${P}"><p:cSld><p:spTree>${shapes.join('')}</p:spTree></p:cSld></p:sld>`;

describe('DOCX', () => {
  const body = [
    para('Cardiac output equals ', 'heart rate times stroke volume.'),
    '<w:p/>',
    para('   '),
    `<w:p><w:r><w:t>Before</w:t></w:r><w:r><w:tab/><w:t>after the tab</w:t></w:r><w:r><w:br/><w:t>second line</w:t></w:r></w:p>`,
    // tracked deletion: w:delText is not text of the document
    `<w:p><w:r><w:t>Kept words</w:t></w:r><w:del><w:r><w:delText>deleted words</w:delText></w:r></w:del></w:p>`,
    // a table: each cell paragraph is a paragraph
    `<w:tbl><w:tr><w:tc>${para('Drug')}</w:tc><w:tc>${para('Mechanism of action')}</w:tc></w:tr></w:tbl>`,
    // a text box in a paragraph: its own paragraph; its Fallback twin is not imported twice
    `<w:p><w:r><w:t>Outer text</w:t></w:r><mc:AlternateContent><mc:Choice><w:r><w:txbxContent>${para('Boxed text')}</w:txbxContent></w:r></mc:Choice><mc:Fallback><w:r><w:txbxContent>${para('Boxed text')}</w:txbxContent></w:r></mc:Fallback></mc:AlternateContent></w:p>`,
    para('* * *'),
  ].join('');

  it('one candidate per non-empty paragraph, with the file name and a paragraph locator', async () => {
    const set = await importDocument({ name: 'physiology notes.docx', bytes: docx(body) }, opts);
    expect(set.format).toBe('docx');
    expect(set.highlights.map((h) => h.quote)).toEqual([
      'Cardiac output equals heart rate times stroke volume.',
      'Before\tafter the tab\nsecond line',
      'Kept words',
      'Drug',
      'Mechanism of action',
      'Outer text',
      'Boxed text',
    ]);
    expect(set.highlights[0]).toMatchObject({
      origin: 'imported',
      needsReview: true,
      format: 'docx',
      position: 1,
      file: 'physiology notes.docx',
      locator: 'Paragraph 1',
      sourceTitle: 'physiology notes.docx',
      sourceUrl: null,
      bank: null,
    });
    expect(set.highlights.at(-1)?.locator).toBe('Paragraph 7');
    expect(set.stats).toMatchObject({ records: 7, accepted: 7, duplicates: 0, rejected: 0 });
    expect(set.warnings).toEqual([
      '1 block with no letters or digits (rules, page marks) skipped.',
    ]);
  });

  it('says what it leaves out: images, footnotes and comments', async () => {
    const set = await importDocument(
      {
        name: 'a.docx',
        bytes: docx(para('Some text.'), {
          'word/media/image1.png': new Uint8Array([1, 2, 3]),
          'word/footnotes.xml': '<w:footnotes/>',
        }),
      },
      opts,
    );
    expect(set.warnings).toEqual([
      '1 image skipped: only text is imported.',
      'Not imported: footnotes.',
    ]);
  });

  it('marks repeated paragraphs as duplicates of the import, with their locator', async () => {
    const set = await importDocument(
      { name: 'a.docx', bytes: docx(para('Header') + para('Body text') + para('Header')) },
      opts,
    );
    expect(set.highlights).toHaveLength(2);
    expect(set.duplicates).toMatchObject([{ position: 3, of: 'import', locator: 'Paragraph 3' }]);
  });

  it('reports existing quotes as duplicates of the vault', async () => {
    const first = await importDocument({ name: 'a.docx', bytes: docx(para('Known fact.')) }, opts);
    const again = await importDocument(
      { name: 'a.docx', bytes: docx(para('Known fact.')) },
      { ...opts, existingQuoteHashes: new Set([first.highlights[0]!.quoteHash]) },
    );
    expect(again.highlights).toHaveLength(0);
    expect(again.duplicates).toMatchObject([{ of: 'existing', locator: 'Paragraph 1' }]);
  });

  it('an empty document is not an error: nothing found, and it says so', async () => {
    const set = await importDocument({ name: 'e.docx', bytes: docx('<w:p/>') }, opts);
    expect(set.stats.records).toBe(0);
    expect(set.warnings).toEqual(['No text was found in this file.']);
  });

  it('refuses a ZIP that is not a Word document', async () => {
    const bytes = zip({ '[Content_Types].xml': '<Types/>', 'ppt/presentation.xml': '<p/>' });
    await expect(importDocument({ name: 'x.docx', bytes }, opts)).rejects.toMatchObject({
      code: 'import_invalid',
      message: expect.stringContaining('word/document.xml'),
    });
  });

  it('refuses XML that is not well formed', async () => {
    const bytes = zip({ 'word/document.xml': '<w:document><w:body><w:p></w:document>' });
    await expect(importDocument({ name: 'x.docx', bytes }, opts)).rejects.toMatchObject({
      code: 'import_invalid',
    });
  });
});

describe('PPTX', () => {
  const pptx = (slides: Record<number, string>, extra: Record<string, string> = {}) =>
    zip({
      '[Content_Types].xml': '<Types/>',
      'ppt/presentation.xml': '<p:presentation/>',
      ...Object.fromEntries(
        Object.entries(slides).map(([n, xml]) => [`ppt/slides/slide${n}.xml`, xml]),
      ),
      ...extra,
    });

  it('one candidate per slide in slide order, footer and slide-number placeholders left out', async () => {
    const set = await importDocument(
      {
        name: 'lecture 4.pptx',
        bytes: pptx(
          {
            10: slideXml(shape(aPara('Last slide'), 'title'), shape(aPara('The end.'))),
            2: slideXml(
              shape(aPara('Beta blockers'), 'title'),
              shape(aPara('Reduce ', 'heart rate'), 'body'),
              shape(aPara('Second bullet')),
              shape(aPara('2'), 'sldNum'),
              shape(aPara('Dept of Cardiology'), 'ftr'),
            ),
            1: slideXml(shape(aPara('   '))),
          },
          { 'ppt/notesSlides/notesSlide2.xml': '<p:notes/>', 'ppt/media/image1.png': 'x' },
        ),
      },
      opts,
    );
    expect(set.format).toBe('pptx');
    expect(set.highlights.map((h) => [h.position, h.locator, h.quote])).toEqual([
      [2, 'Slide 2', 'Beta blockers\nReduce heart rate\nSecond bullet'],
      [10, 'Slide 10', 'Last slide\nThe end.'],
    ]);
    expect(set.highlights[0]).toMatchObject({ file: 'lecture 4.pptx', format: 'pptx' });
    expect(set.warnings).toEqual([
      '1 slide without text skipped.',
      '1 image or media file skipped: only text is imported.',
      'Speaker notes (1 slide) are not imported.',
    ]);
  });

  it('refuses a presentation without slides', async () => {
    await expect(importDocument({ name: 'x.pptx', bytes: pptx({}) }, opts)).rejects.toMatchObject({
      code: 'import_invalid',
    });
  });
});

describe('EPUB', () => {
  const chapter = (title: string, body: string) =>
    `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title><script>window.evil=1</script><style>p{color:red}</style></head><body>${body}</body></html>`;
  const opf = (spine: string[], extra = '') =>
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Cardiac physiology</dc:title></metadata><manifest>` +
    `<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>` +
    `<item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>` +
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>` +
    `<item id="img" href="img/a.png" media-type="image/png"/>${extra}</manifest><spine>${spine
      .map((id) => `<itemref idref="${id}"/>`)
      .join('')}</spine></package>`;
  const container = (path = 'OEBPS/content.opf') =>
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="${path}" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const epub = (extra: Record<string, string> = {}, spine = ['c2', 'c1']) =>
    zip({
      mimetype: 'application/epub+zip',
      'META-INF/container.xml': container(),
      'OEBPS/content.opf': opf(spine),
      'OEBPS/nav.xhtml': chapter('Contents', '<p>Table of contents entry</p>'),
      'OEBPS/text/ch1.xhtml': chapter(
        'One',
        '<h1>The heart</h1><p>The heart&nbsp;has four chambers.<br/>It pumps blood.</p><ul><li>Atria <ul><li>left</li></ul></li></ul><img src="http://evil.test/x.png"/>',
      ),
      'OEBPS/text/ch2.xhtml': chapter('Two', '<p>Valves keep the flow one way.</p>'),
      ...extra,
    });

  it('reads the spine in its own order, with chapter locators, the package title and no scripts', async () => {
    const set = await importDocument({ name: 'physiology.epub', bytes: epub() }, opts);
    expect(set.format).toBe('epub');
    expect(set.highlights.map((h) => [h.locator, h.quote])).toEqual([
      ['Chapter 1, paragraph 1', 'Valves keep the flow one way.'],
      ['Chapter 2, paragraph 1', 'The heart'],
      ['Chapter 2, paragraph 2', 'The heart has four chambers.\nIt pumps blood.'],
      ['Chapter 2, paragraph 3', 'Atria'],
      ['Chapter 2, paragraph 4', 'left'],
    ]);
    expect(set.highlights[0]).toMatchObject({
      format: 'epub',
      file: 'physiology.epub',
      sourceTitle: 'Cardiac physiology',
    });
    expect(JSON.stringify(set)).not.toContain('evil');
    expect(set.warnings).toEqual(['1 image skipped: only text is imported.']);
  });

  it('refuses protected books, and reads font obfuscation as the harmless thing it is', async () => {
    const protectedMessage = expect.stringContaining('protected');
    await expect(
      importDocument({ name: 'b.epub', bytes: epub({ 'META-INF/rights.xml': '<rights/>' }) }, opts),
    ).rejects.toMatchObject({ code: 'import_invalid', message: protectedMessage });
    const enc = (algorithm: string) =>
      `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptionMethod Algorithm="${algorithm}"/></EncryptedData></encryption>`;
    await expect(
      importDocument(
        {
          name: 'b.epub',
          bytes: epub({
            'META-INF/encryption.xml': enc('http://www.w3.org/2001/04/xmlenc#aes128-cbc'),
          }),
        },
        opts,
      ),
    ).rejects.toMatchObject({ code: 'import_invalid', message: protectedMessage });
    const fonts = await importDocument(
      {
        name: 'b.epub',
        bytes: epub({ 'META-INF/encryption.xml': enc('http://www.idpf.org/2008/embedding') }),
      },
      opts,
    );
    expect(fonts.highlights.length).toBeGreaterThan(0);
  });

  it('a manifest path that leaves the package is skipped, never followed', async () => {
    const bytes = epub({
      'OEBPS/content.opf': opf(['c1', 'c2'], '').replace('text/ch2.xhtml', '../../outside.xhtml'),
    });
    const set = await importDocument({ name: 'b.epub', bytes }, opts);
    expect(set.warnings).toContain('1 chapter could not be read and was skipped.');
    expect(set.highlights.every((h) => h.locator?.startsWith('Chapter 1,'))).toBe(true);
  });

  it('refuses an EPUB without a container or without chapters', async () => {
    await expect(
      importDocument({ name: 'x.epub', bytes: zip({ mimetype: 'application/epub+zip' }) }, opts),
    ).rejects.toMatchObject({ code: 'import_invalid' });
    await expect(
      importDocument({ name: 'x.epub', bytes: epub({}, []) }, opts),
    ).rejects.toMatchObject({ code: 'import_invalid' });
  });
});

describe('HTML', () => {
  const html = (body: string, head = '') =>
    strToU8(
      `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`,
    );

  afterEach(() => {
    delete (globalThis as { __svRan?: boolean }).__svRan;
  });

  it('text blocks in order, whitespace collapsed, <pre> kept, scripts and styles gone', async () => {
    const bytes = html(
      [
        '<script>globalThis.__svRan = true</script>',
        '<style>.x{display:none}</style>',
        '<h1>  Renal   physiology </h1>',
        '<p>The nephron   filters <b>plasma</b>,<br>then reabsorbs water.</p>',
        '<div>Intro <p>Inner paragraph</p> tail</div>',
        '<pre>line one\n  line two</pre>',
        '<table><tr><td>Na</td><td>140</td></tr></table>',
        '<img src="http://evil.test/pixel.png" onerror="globalThis.__svRan = true">',
        '<iframe src="http://evil.test/frame"></iframe>',
        '<p>&nbsp;</p>',
      ].join(''),
      '<title> Renal notes </title>',
    );
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const set = await importDocument({ name: 'renal.html', bytes }, opts);
    vi.unstubAllGlobals();

    expect(set.format).toBe('html');
    expect(set.highlights.map((h) => h.quote)).toEqual([
      'Renal physiology',
      'The nephron filters plasma,\nthen reabsorbs water.',
      'Intro',
      'Inner paragraph',
      'tail',
      'line one\n  line two',
      'Na',
      '140',
    ]);
    expect(set.highlights[0]).toMatchObject({
      sourceTitle: 'Renal notes',
      file: 'renal.html',
      locator: 'Paragraph 1',
    });
    expect((globalThis as { __svRan?: boolean }).__svRan).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(set.warnings).toEqual(['1 image skipped: only text is imported.']);
  });

  it('uses the file name when the page has no title, and reads a declared charset', async () => {
    const latin1 = Uint8Array.from([
      ...strToU8('<html><head><meta charset="windows-1252"></head><body><p>Caf'),
      0xe9,
      ...strToU8(' au lait</p></body></html>'),
    ]);
    const set = await importDocument({ name: 'cafe.htm', bytes: latin1 }, opts);
    expect(set.highlights[0]).toMatchObject({ quote: 'Café au lait', sourceTitle: 'cafe.htm' });
  });

  it('survives a deep nest (the parser caps depth at 512 in browsers) and bidi/control characters', async () => {
    const deep = `${'<div>'.repeat(400)}Deep text\u202E hidden \u0007bell${'</div>'.repeat(400)}`;
    const set = await importDocument({ name: 'deep.html', bytes: html(deep) }, opts);
    expect(set.highlights.map((h) => h.quote)).toEqual(['Deep text hidden bell']);
  });
});

describe('Anki plain-text exports', () => {
  const header = [
    '#separator:tab',
    '#html:true',
    '#guid column:1',
    '#notetype column:2',
    '#deck column:3',
    '#tags column:6',
  ].join('\n');
  const row = (...cols: string[]) => cols.join('\t');

  it('recognises the export by its first line only', () => {
    expect(looksLikeAnkiText(`${header}\nx`)).toBe(true);
    expect(looksLikeAnkiText('\uFEFF#separator:Comma\r\n')).toBe(true);
    expect(looksLikeAnkiText('# Heading\n\n> quote')).toBe(false);
    expect(looksLikeAnkiText('quote,comment\n"a","b"')).toBe(false);
    expect(looksLikeAnkiText('#hashtag: not a directive')).toBe(false);
  });

  it('turns Basic and Cloze notes into quote + comment, keeps tags, deck and note number', async () => {
    const text = [
      header,
      row(
        'g1',
        'Basic',
        'Cardiology::Pharm::Drugs',
        'Which enzyme does aspirin<br>inhibit?',
        'COX-1, <b>irreversibly</b>.<img src="evil.png"> [sound:x.mp3]',
        'pharm high_yield cardio::drugs',
      ),
      row(
        'g2',
        'Cloze',
        'Cardiology',
        '"Aspirin inhibits {{c1::COX-1::enzyme}} and {{c2::thromboxane}}."',
        'Extra: dose matters',
        '',
      ),
      row('g3', 'Basic', 'Cardiology', 'Only a front', '', 'x'),
      row('g4', 'Basic', 'Cardiology', 'Front', '"Back with ""quotes""\nand a second line"', ''),
      row('g5', 'Basic', 'Cardiology', '', '', ''),
    ].join('\n');
    const set = await importAnkiHighlights(text, { ...opts, name: 'cardio.txt' });
    expect(set.format).toBe('anki');
    expect(set.highlights.map((h) => [h.position, h.quote, h.comment])).toEqual([
      [1, 'COX-1, irreversibly.', 'Front: Which enzyme does aspirin\ninhibit?'],
      [2, 'Aspirin inhibits COX-1 and thromboxane.', 'Extra: dose matters'],
      [3, 'Only a front', ''],
      [4, 'Back with "quotes"\nand a second line', 'Front: Front'],
    ]);
    expect(set.highlights[0]).toMatchObject({
      tags: ['pharm', 'high_yield', 'cardio::drugs'],
      bank: 'Cardiology',
      folder: 'Pharm / Drugs',
      file: 'cardio.txt',
      locator: 'Note 1',
      sourceTitle: 'cardio.txt',
    });
    expect(set.rejected).toEqual([{ position: 5, reason: 'empty_quote', locator: 'Note 5' }]);
    expect(set.warnings).toEqual(['1 field had images, which are not imported (text only).']);
  });

  it('honours another separator and plain text (#html:false), and guesses a missing one', async () => {
    const piped = ['#separator:Pipe', '#html:false', 'Why <b>x</b>?|Because & so.'].join('\n');
    const set = await importAnkiHighlights(piped, opts);
    expect(set.highlights[0]).toMatchObject({
      quote: 'Because & so.',
      comment: 'Front: Why <b>x</b>?',
    });
    const guessed = await importAnkiHighlights('#html:true\nQ1\tA1\nQ2\tA2\n', opts);
    expect(guessed.highlights.map((h) => h.quote)).toEqual(['A1', 'A2']);
    expect(guessed.warnings?.[0]).toContain('guessed');
  });

  it('reads StudyVault’s own Anki export back', async () => {
    const out = exportAnki(exportDataset());
    const set = await importAnkiHighlights(out.content, { ...opts, name: out.filename });
    expect(set.stats.records).toBe(out.noteCount);
    expect(set.highlights.length).toBeGreaterThan(0);
    for (const h of set.highlights) {
      expect(h.quote.length).toBeGreaterThan(0);
      expect(h.locator).toMatch(/^Note \d+$/);
    }
    // the cloze card of the fixture reads as its sentence, deletions filled in
    expect(set.highlights.map((h) => h.quote)).toContain(
      'Aspirin inhibits COX-1 and thromboxane A2 synthesis',
    );
  });

  it('refuses a quoted field that never ends, with a typed error', async () => {
    await expect(
      importAnkiHighlights('#separator:tab\n"never closed\tb', opts),
    ).rejects.toMatchObject({ code: 'import_invalid' });
  });

  it('is bounded: unclosed cloze markup is read once, and a field over 100,000 characters refuses the file', async () => {
    const t0 = performance.now();
    const set = await importAnkiHighlights(
      `#separator:tab\n#html:true\n${'{{c1::'.repeat(16_000)}x\tBack\n`,
      opts,
    );
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(set.rejected).toMatchObject([{ position: 1, reason: 'quote_too_long' }]);

    await expect(
      importAnkiHighlights(`#separator:tab\n${'a'.repeat(100_001)}\tb\n`, {
        ...opts,
        limits: { maxBytes: 8 * MiB },
      }),
    ).rejects.toMatchObject({
      code: 'import_invalid',
      message: expect.stringContaining('Anki export: a field is longer'),
    });
  });
});

describe('unsupported and hostile files', () => {
  it('names what is not supported instead of failing vaguely', async () => {
    await expect(
      importDocument({ name: 'deck.apkg', bytes: new Uint8Array([0x50, 0x4b, 3, 4]) }, opts),
    ).rejects.toMatchObject({ code: 'import_invalid', message: expect.stringContaining('SQLite') });
    await expect(
      importDocument({ name: 'old.doc', bytes: new Uint8Array(8) }, opts),
    ).rejects.toMatchObject({ code: 'import_invalid', message: expect.stringContaining('.doc') });
    const ole = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    await expect(importDocument({ name: 'locked.docx', bytes: ole }, opts)).rejects.toMatchObject({
      code: 'import_invalid',
      message: expect.stringContaining('password-protected'),
    });
    await expect(
      importDocument({ name: 'plain.docx', bytes: strToU8('just text') }, opts),
    ).rejects.toMatchObject({ code: 'import_invalid' });
    await expect(
      importDocument({ name: 'x.rtf', bytes: strToU8('{\\rtf1}') }, opts),
    ).rejects.toMatchObject({ code: 'import_invalid' });
  });

  it('refuses a file over the size limit before reading it', async () => {
    await expect(
      importDocument(
        { name: 'a.docx', bytes: docx(para('x')) },
        { ...opts, documentLimits: { maxFileBytes: 100 } },
      ),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
  });

  it('a zip bomb with an honest header is refused by its expansion ratio, before any entry is read', async () => {
    const bomb = zip({
      '[Content_Types].xml': '<Types/>',
      'word/document.xml': new Uint8Array(20 * MiB),
    });
    expect(bomb.length).toBeLessThan(200 * 1024);
    const e = await importDocument({ name: 'bomb.docx', bytes: bomb }, opts).catch((x) => x);
    expect(e).toMatchObject({ code: 'limit_exceeded' });
    expect(e.message).toContain('zip bomb');
  });

  it('an entry over the per-entry cap is refused even when the ratio is below the archive guard', async () => {
    const bytes = zip({
      '[Content_Types].xml': '<Types/>',
      'word/document.xml': new Uint8Array(2 * MiB),
    });
    await expect(
      importDocument(
        { name: 'big.docx', bytes },
        { ...opts, documentLimits: { maxEntryBytes: 1 * MiB } },
      ),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
  });

  it('a header that understates the stream cannot make the reader run: refused, quickly', async () => {
    const bytes = declareSize(
      zip({ 'word/document.xml': new Uint8Array(6 * MiB) }),
      'word/document.xml',
      100,
    );
    const t0 = performance.now();
    await expect(importDocument({ name: 'lie.docx', bytes }, opts)).rejects.toMatchObject({
      code: 'import_invalid',
    });
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it('a header that overstates the stream is refused too', async () => {
    const real = strToU8(docxXml(para('Hello there.')));
    const bytes = declareSize(
      zip({ 'word/document.xml': real }),
      'word/document.xml',
      real.length + 5,
    );
    await expect(importDocument({ name: 'lie.docx', bytes }, opts)).rejects.toMatchObject({
      code: 'import_invalid',
    });
  });

  it('too many entries are refused from the directory alone', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5_001; i++) files[`f${i}.txt`] = '';
    await expect(
      importDocument({ name: 'many.docx', bytes: zip(files, 0) }, opts),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
  });

  it.each([
    ['a parent segment', '../../evil.xml'],
    ['an absolute path', '/etc/passwd'],
    ['a drive path', 'C:/Windows/evil.xml'],
    ['a backslash', 'word\\document.xml'],
    ['a nested parent segment', 'word/../../evil.xml'],
  ])('refuses an entry name with %s', async (_what, name) => {
    const bytes = zip({ 'word/document.xml': docxXml(para('Hi.')), [name]: 'x' });
    await expect(importDocument({ name: 'trav.docx', bytes }, opts)).rejects.toMatchObject({
      code: 'import_invalid',
      message: expect.stringContaining('unsafe name'),
    });
  });

  it('refuses entities (billion laughs, external entity) before the parser sees them', async () => {
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
    const laughs =
      '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">' +
      '<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>';
    const xxe = '<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]>';
    for (const doctype of [laughs, xxe]) {
      const xml = `${XML}${doctype}<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>&lol3;&x;</w:t></w:r></w:p></w:body></w:document>`;
      const bytes = zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': xml });
      await expect(importDocument({ name: 'ent.docx', bytes }, opts)).rejects.toMatchObject({
        code: 'import_invalid',
        message: expect.stringContaining('entities'),
      });
    }
    expect(parse).not.toHaveBeenCalled();
    // an entity reference without a declaration is simply not well-formed
    const undeclared = zip({
      'word/document.xml': `${XML}<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>&lol;</w:t></w:r></w:p></w:body></w:document>`,
    });
    await expect(
      importDocument({ name: 'ent.docx', bytes: undeclared }, opts),
    ).rejects.toMatchObject({
      code: 'import_invalid',
    });
  });

  it('a 2,000,000-character paragraph is rejected as too long, never imported cut', async () => {
    let state = 1;
    let text = '';
    const letters = 'abcdefghijklmnopqrstuvwxyz ';
    for (let i = 0; i < 2_000_000; i++) {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      text += letters[state % letters.length];
    }
    const t0 = performance.now();
    const set = await importDocument(
      { name: 'huge.docx', bytes: docx(para('A normal paragraph.') + para(text)) },
      opts,
    );
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(set.highlights.map((h) => h.quote)).toEqual(['A normal paragraph.']);
    expect(set.rejected).toMatchObject([
      { position: 2, reason: 'quote_too_long', locator: 'Paragraph 2' },
    ]);
  });

  it('a markup part over the parser cap is refused without parsing it', async () => {
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
    await expect(
      importDocument(
        { name: 'big.docx', bytes: docx(para('x'.repeat(5_000))) },
        { ...opts, documentLimits: { maxMarkupBytes: 1_000 } },
      ),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
    expect(parse).not.toHaveBeenCalled();
  });

  it('caps the text taken from one file and the number of blocks', async () => {
    const many = docx(Array.from({ length: 6 }, (_, i) => para(`Paragraph number ${i}`)).join(''));
    await expect(
      importDocument({ name: 'm.docx', bytes: many }, { ...opts, limits: { maxRecords: 5 } }),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
    await expect(
      importDocument(
        { name: 'm.docx', bytes: many },
        { ...opts, documentLimits: { maxTextChars: 40 } },
      ),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
  });

  it('damaged archives are invalid files, not crashes', async () => {
    const good = docx(para('Some words here.'));
    await expect(
      importDocument({ name: 'cut.docx', bytes: good.slice(0, good.length - 40) }, opts),
    ).rejects.toMatchObject({ code: 'import_invalid' });
    const flipped = good.slice();
    // damage the deflate stream of word/document.xml (after the first local header)
    for (let i = 120; i < 160; i++) flipped[i] = (flipped[i] as number) ^ 0xff;
    await expect(importDocument({ name: 'bad.docx', bytes: flipped }, opts)).rejects.toMatchObject({
      code: expect.stringMatching(/^(import_invalid|limit_exceeded)$/),
    });
  });
});

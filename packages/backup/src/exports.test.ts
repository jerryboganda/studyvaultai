// @vitest-environment node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { exportAnki, toAnkiCloze } from './anki';
import { csvCell, exportHighlightsCsv, exportHighlightsJson, parseCsv, toCsv } from './csv';
import { exportDataset, INJECTION_QUOTE } from './exportData';
import { safeFilename, uniquePaths } from './filenames';
import { escapeMarkdown, exportMarkdown, markdownTag } from './markdown';
import { zipFiles } from './zipFiles';

const EXPORTED_AT = new Date('2026-10-11T08:30:00.000Z');

/** Golden-file check. First run (or SV_UPDATE_GOLDEN=1) writes the file; review it before committing. */
function golden(name: string, actual: string): void {
  const path = resolve(__dirname, 'fixtures', 'golden', name);
  const visible = actual.replace(/\r/g, '<CR>');
  if (process.env.SV_UPDATE_GOLDEN === '1' || !existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, visible);
    if (process.env.SV_UPDATE_GOLDEN !== '1')
      throw new Error(`golden ${name} was missing and has been written; review it`);
    return;
  }
  expect(visible).toBe(readFileSync(path, 'utf8'));
}

const files = (opts: Parameters<typeof exportMarkdown>[1] = {}) =>
  exportMarkdown(exportDataset(), { exportedAt: EXPORTED_AT, ...opts });
const asText = (fs: ReturnType<typeof files>) =>
  fs.map((f) => `=== ${f.path} ===\n${f.content}`).join('\n');

describe('Markdown export', () => {
  it('per-bank layout matches the golden file', () => {
    golden('markdown-per-bank.md', asText(files()));
  });

  it('single combined file matches the golden file', () => {
    const out = files({ layout: 'single' });
    expect(out).toHaveLength(1);
    golden('markdown-single.md', asText(out));
  });

  it('per-folder layout nests bank/folder directories', () => {
    const out = files({ layout: 'per-folder' });
    golden('markdown-per-folder.md', asText(out));
    const paths = out.map((f) => f.path);
    expect(paths).toContain('Cardiology/Pharmacology.md');
    expect(paths.some((p) => p.startsWith('Cardiology/Pharmacology/'))).toBe(true);
  });

  it('obsidian dialect adds wiki links, block ids and an index', () => {
    const out = files({ obsidian: true });
    golden('markdown-obsidian.md', asText(out));
    const index = out.find((f) => f.path === 'StudyVault Index.md');
    expect(index?.content).toContain('[[Cardiology]]');
    const cardio = out.find((f) => f.path === 'Cardiology.md')!.content;
    expect(cardio).toMatch(/\^sv-hl-0001/);
    expect(cardio).toContain('[[');
  });

  it('every path is a valid, unique, case-insensitively distinct Windows file name', () => {
    for (const layout of ['single', 'per-bank', 'per-folder'] as const) {
      const out = files({ layout, obsidian: true });
      const lower = out.map((f) => f.path.toLowerCase());
      expect(new Set(lower).size).toBe(lower.length);
      for (const f of out) {
        for (const seg of f.path.split('/')) {
          // eslint-disable-next-line no-control-regex
          expect(seg).not.toMatch(/[<>:"\\|?*\u0000-\u001f]/);
          expect(seg).not.toMatch(/[. ]$/);
          expect(seg.split('.')[0]!.toLowerCase()).not.toMatch(/^(con|prn|aux|nul|com\d|lpt\d)$/);
        }
      }
    }
    expect(files().map((f) => f.path)).toEqual(
      expect.arrayContaining(['_CON.md', 'Exam_ Q&A_ _2026__draft_.md']),
    );
  });

  it('hostile quotes stay inside their blockquote and cannot become links, embeds or headings', () => {
    const text = asText(files());
    const quote = text.slice(text.indexOf('> \\[\\[evil'));
    const block = quote.slice(0, quote.indexOf('\n\n'));
    expect(block.split('\n').every((l) => l.startsWith('>'))).toBe(true);
    expect(block).toContain('\\[\\[evil\\]\\]');
    expect(block).toContain('!\\[\\[embedded note\\]\\]');
    expect(block).toContain('\\<script\\>');
    expect(block).toContain('\\# not a heading');
    expect(block).toContain('\\- not a list');
    expect(block).toContain('\\---');
    // no unescaped wiki link or javascript: destination anywhere in the output
    expect(text).not.toMatch(/(?<!\\)\[\[/);
    expect(text).not.toMatch(/(?<!\\)\]\(javascript:/i);
    expect(text).not.toMatch(/(?<!\\)<script/i);
    // a quote cannot add front matter
    for (const f of files()) expect(f.content.match(/^---$/gm)?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it('links only http(s) sources and survives parentheses in URLs', () => {
    const text = asText(files());
    expect(text).toContain('(https://example.com/a?utm=1)');
    expect(text).toContain('— Unsafe link source'); // shown as plain text, no link
    expect(text).not.toMatch(/(?<!\\)\]\(javascript:/i);
    const withParen = exportMarkdown(
      {
        ...exportDataset(),
        highlights: [{ ...exportDataset().highlights[0]!, capturedUrl: 'https://e.com/a(b)c' }],
      },
      { exportedAt: EXPORTED_AT },
    );
    expect(withParen.map((f) => f.content).join('')).toContain('https://e.com/a%28b%29c');
  });

  it('includes citation facts: title, date, page or text offset, tags', () => {
    const text = asText(files());
    expect(text).toContain('captured 2026-10-01');
    expect(text).toContain('page 3');
    expect(text).toMatch(/text offset \d+\u2013\d+/);
    expect(text).toContain('#heart-failure');
    expect(text).toContain('#t2026'); // purely numeric tags are not valid Markdown tags
  });

  it('omits soft-deleted highlights and banks unless asked', () => {
    expect(asText(files())).not.toContain('This one was deleted');
    expect(asText(files())).not.toContain('Deleted bank');
    expect(asText(files({ includeDeleted: true }))).toContain('This one was deleted');
  });

  it('front matter is valid JSON-quoted YAML scalars and can be turned off', () => {
    const f = files()[0]!.content;
    expect(f.startsWith('---\ntitle: "')).toBe(true);
    const bare = files({ frontMatter: false });
    expect(bare.every((x) => !x.content.startsWith('---'))).toBe(true);
  });

  it('zipFiles packs the files', () => {
    const z = unzipSync(zipFiles(files(), EXPORTED_AT));
    expect(Object.keys(z).sort()).toEqual(
      files()
        .map((f) => f.path)
        .sort(),
    );
  });
});

describe('escaping primitives', () => {
  it('escapeMarkdown neutralises syntax but keeps text readable', () => {
    expect(escapeMarkdown('a*b_c [x](y) <b> `c` & $1 ==h== %%c%%')).toBe(
      'a\\*b\\_c \\[x\\](y) \\<b\\> \\`c\\` \\& \\$1 \\=\\=h\\=\\= \\%\\%c\\%\\%',
    );
  });

  it('markdownTag', () => {
    expect(markdownTag('heart failure')).toBe('heart-failure');
    expect(markdownTag('123')).toBe('t123');
    expect(markdownTag('###')).toBeNull();
    expect(markdownTag('a/b c')).toBe('a/b-c');
  });
});

describe('safeFilename / uniquePaths', () => {
  it.each([
    ['a<b>c:d"e/f\\g|h?i*j', 'a_b_c_d_e_f_g_h_i_j'],
    ['CON', '_CON'],
    ['nul.txt', '_nul.txt'],
    ['COM1', '_COM1'],
    ['lpt9', '_lpt9'],
    ['report.', 'report'],
    ['trailing space ', 'trailing space'],
    ['..', '__'],
    ['.hidden', '_hidden'],
    ['', 'untitled'],
    ['   ', 'untitled'],
    ['../../etc/passwd', '___.._etc_passwd'],
    ['line\nbreak\tTab', 'line_break_Tab'],
    ['rtl\u202Eevil.exe', 'rtlevil.exe'],
    ['zero\u200Bwidth', 'zerowidth'],
  ])('%j -> %j', (input, expected) => {
    expect(safeFilename(input)).toBe(expected);
  });

  it('cuts on code points and keeps results non-empty', () => {
    const s = safeFilename('\u{1F600}'.repeat(200), { maxLength: 10 });
    expect([...s]).toHaveLength(10);
    expect(safeFilename('.'.repeat(500))).toMatch(/^_{1,80}$/);
    expect(safeFilename('a'.repeat(300))).toHaveLength(80);
  });

  it('uniquePaths is case-insensitive and keeps extensions', () => {
    expect(uniquePaths(['A.md', 'a.md', 'b/A.md', 'B/a.MD', 'A.md'])).toEqual([
      'A.md',
      'a (2).md',
      'b/A.md',
      'B/a.MD (2)'.replace('.MD (2)', ' (2).MD'),
      'A (3).md',
    ]);
  });
});

describe('CSV', () => {
  it('highlights export matches the golden file', () => {
    golden('highlights.csv', exportHighlightsCsv(exportDataset()));
  });

  it('RFC 4180 quoting round trips through parseCsv', () => {
    const rows = [
      [
        'plain',
        'with,comma',
        'with "quote"',
        'multi\nline',
        ' lead',
        'trail ',
        '',
        'caf\u00e9 \u65e5\u672c',
      ],
      ['1', '2'],
    ];
    const text = toCsv(rows, { formulaGuard: false });
    expect(text).toBe(
      'plain,"with,comma","with ""quote""","multi\nline"," lead","trail ",,caf\u00e9 \u65e5\u672c\r\n1,2\r\n',
    );
    expect(parseCsv(text)).toEqual([rows[0], rows[1]]);
  });

  it('guards spreadsheet formulas', () => {
    for (const bad of ['=1+1', '+1', '-1', '@SUM(A1)', '\t=1', '=HYPERLINK("x")']) {
      expect(csvCell(bad)).toMatch(/^"?'/);
    }
    expect(csvCell('=1+1', { formulaGuard: false })).toBe('=1+1');
    expect(csvCell('safe =1')).toBe('safe =1');
    expect(csvCell(-5)).toBe('-5'); // real numbers are not text
    const csv = exportHighlightsCsv(exportDataset());
    const records = parseCsv(csv);
    const header = records[0]!;
    const quoteCol = header.indexOf('quote');
    const commentCol = header.indexOf('comment');
    for (const r of records.slice(1)) {
      for (const cell of [r[quoteCol]!, r[commentCol]!]) {
        expect(cell).not.toMatch(/^[=+\-@\t\r]/);
      }
    }
    expect(records.find((r) => r[quoteCol]!.includes('HYPERLINK'))![quoteCol]).toBe(
      '\'=HYPERLINK("http://evil.test","click")',
    );
  });

  it('puts a highlight filed in two banks on two rows and honours delimiter/BOM', () => {
    const records = parseCsv(exportHighlightsCsv(exportDataset()));
    expect(records.filter((r) => r[0] === 'hl-0007')).toHaveLength(2);
    const semi = exportHighlightsCsv(exportDataset(), { delimiter: ';', bom: true, newline: '\n' });
    expect(semi.startsWith('\uFEFFid;bank;')).toBe(true);
    expect(parseCsv(semi, ';')[0]).toHaveLength(17);
  });

  it('parseCsv rejects unterminated quotes and over-long input', () => {
    expect(() => parseCsv('a,"b')).toThrow(/never closed/);
    expect(() =>
      parseCsv('a\nb\nc', ',', { maxRecords: 2, maxColumns: 8, maxFieldChars: 10 }),
    ).toThrow(/more than/);
    expect(() =>
      parseCsv('a,b,c', ',', { maxRecords: 5, maxColumns: 2, maxFieldChars: 10 }),
    ).toThrow(/columns/);
  });

  it('JSON view is plain data', () => {
    const j = JSON.parse(exportHighlightsJson(exportDataset())) as {
      id: string;
      banks: unknown[];
    }[];
    expect(j).toHaveLength(6);
    expect(j.find((h) => h.id === 'hl-0007')?.banks).toHaveLength(2);
  });
});

describe('Anki export', () => {
  it('tab separated file with header directives matches the golden file', () => {
    const a = exportAnki(exportDataset());
    golden('anki.txt', a.content);
    expect(a.noteCount).toBe(4);
    expect(a.skipped).toEqual([{ id: 'card-005', reason: 'suspended' }]);
    expect(a.columns.map((c) => c.name)).toEqual([
      'GUID',
      'Note type',
      'Deck',
      'Front',
      'Back',
      'Tags',
    ]);
    expect(a.noteTypes.map((n) => [n.name, n.notes])).toEqual([
      ['Basic', 2],
      ['Cloze', 2],
    ]);
    expect(a.content.split('\n').slice(0, 6)).toEqual([
      '#separator:tab',
      '#html:true',
      '#guid column:1',
      '#notetype column:2',
      '#deck column:3',
      '#tags column:6',
    ]);
  });

  it('separate Source column with custom note types', () => {
    const a = exportAnki(exportDataset(), {
      sourcePlacement: 'field',
      format: 'csv',
      includeSuspended: true,
    });
    golden('anki-field.csv', a.content);
    expect(a.separator).toBe('Comma');
    expect(a.columns.map((c) => c.name)).toEqual([
      'GUID',
      'Note type',
      'Deck',
      'Front',
      'Back',
      'Source',
      'Tags',
    ]);
    expect(a.content).toContain('#tags column:7');
    expect(a.noteTypes.map((n) => n.name)).toEqual(['StudyVault Basic', 'StudyVault Cloze']);
  });

  it('GUIDs are stable per card and independent of order or options', () => {
    const d = exportDataset();
    const guids = (a: ReturnType<typeof exportAnki>) =>
      a.content
        .split('\n')
        .filter((l) => l.startsWith('sv-'))
        .map((l) => l.split(/[\t,]/)[0]);
    const one = guids(exportAnki(d));
    const reversed = guids(
      exportAnki(
        { ...d, cards: [...(d.cards ?? [])].reverse() },
        { sourcePlacement: 'field', format: 'csv' },
      ),
    );
    expect(one).toEqual(['sv-card-001', 'sv-card-002', 'sv-card-003', 'sv-card-004']);
    expect(reversed).toEqual(one);
  });

  it('HTML in cards and sources is escaped', () => {
    const a = exportAnki(exportDataset());
    expect(a.content).toContain('One and two are numbers &lt;b&gt;');
    expect(a.content).not.toMatch(/<(script|img)/);
    const rows = parseCsv(a.content.split('\n').slice(6).join('\n'), '\t');
    const first = rows.find((r) => r[0] === 'sv-card-001')!;
    expect(first[4]).toContain(
      '<a href="https://example.com/a?utm=1">Aspirin [mechanism] *notes*</a>',
    );
  });

  it('formulas are guarded by default', () => {
    const a = exportAnki(exportDataset(), { includeSuspended: true });
    expect(a.content).toContain("'=cmd|&#39;".replace('&#39;', "'")); // guarded, quotes untouched by HTML
    expect(
      exportAnki(exportDataset(), { includeSuspended: true, formulaGuard: false }).content,
    ).toMatch(/\t=cmd/);
  });
});

describe('Anki cloze mapping', () => {
  it.each([
    ['{{c1::A}} and {{c2::B}}', 1, '{{c1::A}} and B'],
    ['{{c1::A}} and {{c2::B}}', 2, 'A and {{c1::B}}'],
    ['{{c1::A::hint}} and {{c2::B}}', 1, '{{c1::A::hint}} and B'],
    ['{{c1::A}} and {{c2::B}}', null, '{{c1::A}} and {{c1::B}}'],
    ['x {{c2::outer {{c3::inner}}}} y', 3, 'x outer {{c1::inner}} y'],
    ['x {{c2::outer {{c3::inner}}}} y', 2, 'x {{c1::outer inner}} y'],
    ['x {{c1::outer {{c2::inner}}}} y', null, 'x {{c1::outer inner}} y'],
    ['no cloze here', 1, 'no cloze here'],
    ['broken {{c1::never closed', 1, 'broken {{c1::never closed'],
  ])('%j active=%s -> %j', (markup, active, expected) => {
    expect(toAnkiCloze(markup, active)).toBe(expected);
  });
});

describe('quotes survive the human formats', () => {
  it('INJECTION_QUOTE is the same text after a CSV round trip', () => {
    const records = parseCsv(exportHighlightsCsv(exportDataset()));
    const q = records.find((r) => r[0] === 'hl-0002')![3]!;
    expect(q).toBe(INJECTION_QUOTE);
  });
});

describe('Markdown edge cases', () => {
  it('a highlight in no bank goes to an "Unfiled" file and nothing is lost', () => {
    const d = exportDataset();
    const out = exportMarkdown(
      { ...d, highlightBanks: d.highlightBanks.filter((m) => m.highlightId !== 'hl-0005') },
      { exportedAt: EXPORTED_AT },
    );
    const unfiled = out.find((f) => f.path === 'Unfiled.md');
    expect(unfiled?.content).toContain('Ünïcödé');
    expect(out.map((f) => f.content).join('')).toContain('Statins reduce LDL');
  });

  it('an empty dataset still yields a valid file', () => {
    const out = exportMarkdown(
      { banks: [], sources: [], highlights: [], highlightBanks: [] },
      { layout: 'single', exportedAt: EXPORTED_AT },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toContain('_No highlights._');
  });

  it('is deterministic', () => {
    expect(asText(files())).toBe(asText(files()));
  });
});

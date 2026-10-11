// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { exportHighlightsCsv, toCsv } from './csv';
import { exportDataset, INJECTION_QUOTE } from './exportData';
import { importCsvHighlights, importMarkdownHighlights } from './importExternal';
import { exportMarkdown } from './markdown';
import { normalizeQuote, quoteHash, safeHttpUrl } from './text';
import { subtle } from './testkit';

const opts = { subtle } as const;

describe('quote normalisation parity with @storage', () => {
  it('uses the same rule and the same SHA-256 hex', async () => {
    // vectors copied from packages/storage/src/normalize.test.ts
    expect(normalizeQuote('  Áspirin  \n\tACTS  ')).toBe('áspirin acts');
    expect(normalizeQuote('ﬁbrin ＡBC')).toBe('fibrin abc');
    expect(await quoteHash(subtle, 'abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('safeHttpUrl', () => {
  it.each([
    ['https://example.com/a', 'https://example.com/a'],
    ['  http://example.com  ', 'http://example.com/'],
    ['https://user:pw@example.com/x', 'https://example.com/x'],
    ['javascript:alert(1)', null],
    ['data:text/html,<script>', null],
    ['file:///etc/passwd', null],
    ['chrome-extension://abc/page.html', null],
    ['//example.com', null],
    ['not a url', null],
  ])('%j', (input, out) => {
    expect(safeHttpUrl(input)).toBe(out);
  });
});

describe('Markdown import', () => {
  it('reads StudyVault’s own Markdown export back (quotes, source, tags, comment, hints)', async () => {
    const files = exportMarkdown(exportDataset(), { exportedAt: new Date('2026-10-11T00:00:00Z') });
    const cardio = files.find((f) => f.path === 'Cardiology.md')!;
    const set = await importMarkdownHighlights(cardio.content, opts);
    expect(set.stats).toMatchObject({ records: 3, accepted: 3, duplicates: 0, rejected: 0 });
    const byQuote = (q: string) => set.highlights.find((h) => h.quote === q)!;

    const aspirin = byQuote(
      'Aspirin irreversibly inhibits COX-1.\nIt also reduces thromboxane A2.',
    );
    expect(aspirin).toMatchObject({
      origin: 'imported',
      needsReview: true,
      format: 'markdown',
      bank: 'Cardiology',
      folder: 'Pharmacology / Anti/platelets: "COX"',
      sourceTitle: 'Aspirin [mechanism] *notes*',
      sourceUrl: 'https://example.com/a?utm=1',
      capturedAt: '2026-10-01T00:00:00.000Z',
      kind: 'essential',
      comment: 'Remember: low dose = antiplatelet.',
      tags: ['heart-failure', 't2026'],
    });
    expect(aspirin.quoteHash).toMatch(/^[0-9a-f]{64}$/);
    expect(aspirin.normalizedQuote).toBe(normalizeQuote(aspirin.quote));
  });

  it('hostile quotes come back as the same text, never as structure', async () => {
    const files = exportMarkdown(exportDataset());
    const inbox = files.find((f) => f.path === 'Inbox.md')!;
    const set = await importMarkdownHighlights(inbox.content, opts);
    expect(set.highlights).toHaveLength(1);
    expect(set.highlights[0]!.quote).toBe(INJECTION_QUOTE);
    expect(set.highlights[0]!.sourceUrl).toBeNull(); // the source link was unsafe and never exported
  });

  it('a highlight filed in two banks is imported once (dedupe by quoteHash)', async () => {
    const all = exportMarkdown(exportDataset(), { layout: 'single' })[0]!.content;
    const set = await importMarkdownHighlights(all, opts);
    expect(set.stats.duplicates).toBe(1);
    expect(set.duplicates[0]!.of).toBe('import');
    expect(set.highlights).toHaveLength(6);
  });

  it('treats generic notes sensibly: plain blockquotes, callouts and prose', async () => {
    const md = [
      '---',
      'title: Reading notes',
      '---',
      '# Physiology',
      '',
      '> Cardiac output is heart rate times stroke volume.',
      '',
      'This paragraph is my own prose and is not a comment on the quote.',
      '',
      '> [!note] An Obsidian callout is a note, not a quote',
      '> second line',
      '',
      '## Renal',
      '',
      '> GFR is estimated from creatinine.',
      '> It declines with age.',
      '',
      '#nephrology #exam',
    ].join('\n');
    const set = await importMarkdownHighlights(md, opts);
    expect(set.highlights.map((h) => h.quote)).toEqual([
      'Cardiac output is heart rate times stroke volume.',
      'GFR is estimated from creatinine.\nIt declines with age.',
    ]);
    expect(set.highlights[0]).toMatchObject({ bank: 'Physiology', folder: null, comment: '' });
    expect(set.highlights[1]).toMatchObject({
      bank: 'Physiology',
      folder: 'Renal',
      tags: ['nephrology', 'exam'],
    });
  });

  it('sanitises: control characters, bidi overrides, unsafe links, bad dates, unknown kinds', async () => {
    const md = [
      '> quo\u0000te with \u{202E}evil\u{202C} and \u0007bell',
      '',
      '— [Title](javascript:alert(1)) · captured 2026-13-45 · not_a_kind',
    ].join('\n');
    const set = await importMarkdownHighlights(md, opts);
    const h = set.highlights[0]!;
    expect(h.quote).toBe('quote with evil and bell');
    expect(h.sourceUrl).toBeNull();
    expect(h.sourceTitle).toBe('Title');
    expect(h.capturedAt).toBeNull();
    expect(h.kind).toBeNull();
  });

  it('enforces limits and reports duplicates of existing data', async () => {
    await expect(
      importMarkdownHighlights(Array.from({ length: 10 }, (_, i) => `> q${i}`).join('\n\n'), {
        ...opts,
        limits: { maxRecords: 5 },
      }).catch((e) => e),
    ).resolves.toMatchObject({ code: 'limit_exceeded' });
    await expect(
      importMarkdownHighlights('x'.repeat(5000), { ...opts, limits: { maxBytes: 1000 } }),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });

    const long = `> ${'a'.repeat(50)}\n\n> short one`;
    const set = await importMarkdownHighlights(long, { ...opts, limits: { maxQuoteChars: 20 } });
    expect(set.rejected).toEqual([{ position: 1, reason: 'quote_too_long' }]);
    expect(set.highlights).toHaveLength(1);

    const hash = await quoteHash(subtle, normalizeQuote('Short one'));
    const dup = await importMarkdownHighlights('> SHORT   one', {
      ...opts,
      existingQuoteHashes: new Set([hash]),
    });
    expect(dup.highlights).toHaveLength(0);
    expect(dup.duplicates).toEqual([{ position: 1, quoteHash: hash, of: 'existing' }]);
  });

  it('empty input yields an empty set, not an error', async () => {
    const set = await importMarkdownHighlights('', opts);
    expect(set.stats).toEqual({ records: 0, accepted: 0, duplicates: 0, rejected: 0 });
  });
});

describe('CSV import', () => {
  it('reads StudyVault’s own CSV export back, undoing the formula guard', async () => {
    const csv = exportHighlightsCsv(exportDataset());
    const set = await importCsvHighlights(csv, opts);
    expect(set.stats.records).toBe(7); // hl-0007 is on two rows
    expect(set.stats.duplicates).toBe(1);
    expect(set.highlights).toHaveLength(6);
    const q = (s: string) => set.highlights.find((h) => h.quote === s);
    expect(q('=HYPERLINK("http://evil.test","click")')).toBeDefined();
    expect(q(INJECTION_QUOTE)?.comment).toBe('@SUM(1+1) and <img src=x onerror=alert(1)>');
    const aspirin = q('Aspirin irreversibly inhibits COX-1.\nIt also reduces thromboxane A2.')!;
    expect(aspirin).toMatchObject({
      origin: 'imported',
      bank: 'Cardiology',
      folder: 'Pharmacology / Anti/platelets: "COX"',
      tags: ['heart failure', '2026'],
      sourceUrl: 'https://example.com/a?utm=1',
      capturedAt: '2026-10-01T09:10:00.000Z',
      kind: 'essential',
      position: 2,
    });
  });

  it('recognises common header names and delimiters', async () => {
    const text =
      '\u{FEFF}Text;Tag;Link;Date\n"First; quote";a,b;https://e.com/x;2026-01-02\n"Second";;javascript:x;nope\n';
    const set = await importCsvHighlights(text, opts);
    expect(set.highlights.map((h) => h.quote)).toEqual(['First; quote', 'Second']);
    expect(set.highlights[0]).toMatchObject({
      tags: ['a', 'b'],
      sourceUrl: 'https://e.com/x',
      capturedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(set.highlights[1]).toMatchObject({ sourceUrl: null, capturedAt: null, tags: [] });
  });

  it('rejects structurally broken files with a typed error', async () => {
    await expect(importCsvHighlights('title,url\nx,y', opts)).rejects.toMatchObject({
      code: 'import_invalid',
    });
    await expect(importCsvHighlights('quote\n"unterminated', opts)).rejects.toMatchObject({
      code: 'import_invalid',
    });
    await expect(importCsvHighlights('', opts)).rejects.toMatchObject({ code: 'import_invalid' });
  });

  it('enforces record and size limits, rejects empty and over-long quotes', async () => {
    const many = toCsv([['quote'], ...Array.from({ length: 30 }, (_, i) => [`q${i}`])]);
    await expect(
      importCsvHighlights(many, { ...opts, limits: { maxRecords: 10 } }),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
    const rows = toCsv([
      ['quote', 'comment'],
      ['', 'x'],
      ['a'.repeat(30), ''],
      ['ok', 'c'.repeat(30)],
    ]);
    const set = await importCsvHighlights(rows, {
      ...opts,
      limits: { maxQuoteChars: 20, maxCommentChars: 10 },
    });
    expect(set.rejected.map((r) => r.reason)).toEqual([
      'empty_quote',
      'quote_too_long',
      'comment_too_long',
    ]);
    expect(set.highlights).toHaveLength(0);
  });
});

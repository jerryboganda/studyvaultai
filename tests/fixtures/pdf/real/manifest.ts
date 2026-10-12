import fs from 'node:fs';
import path from 'node:path';

/**
 * The real public-domain PDFs next to this file (about 20 MB, see SOURCES.md). SOURCES.md is the single
 * source of truth: the unit suite (real.integration.test.ts) and the browser specs (tests/e2e/pdf-real*.spec.ts)
 * read the rows between the two sentinel comments below and assert the product against them, so a file
 * that is replaced or truncated, or a reader change that alters what a file reports, fails loudly.
 */

export const REAL_PDF_DIR = path.resolve(process.cwd(), 'tests', 'fixtures', 'pdf', 'real');

export type RealTextStatus = 'text' | 'scanned' | 'partial';

export interface RealPdf {
  file: string;
  /** Absolute path. */
  path: string;
  pages: number;
  bytes: number;
  sha256: string;
  /** What the reader reports for the document: selectable text, a scan with no text, or both. */
  text: RealTextStatus;
  /** Entries of the flattened outline (bookmarks) the reader builds; 0 when the file has none. */
  outline: number;
  /** Pages whose displayed shape is landscape (after /Rotate). */
  landscape: number;
  /** Pages that carry a non-zero /Rotate. */
  rotated: number;
}

const BEGIN = '<!-- real-pdf-manifest:begin -->';
const END = '<!-- real-pdf-manifest:end -->';

export function parseManifest(markdown: string): RealPdf[] {
  const start = markdown.indexOf(BEGIN);
  const stop = markdown.indexOf(END);
  if (start < 0 || stop < start) throw new Error('SOURCES.md has no real-pdf-manifest block.');
  const rows: RealPdf[] = [];
  for (const line of markdown.slice(start + BEGIN.length, stop).split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());
    const name = /^`([^`]+\.pdf)`$/.exec(cells[0] ?? '')?.[1];
    if (!name) continue; // header and separator rows
    if (cells.length !== 8) throw new Error(`SOURCES.md row for ${name} has ${cells.length} cells.`);
    const [, pages, bytes, sha, text, outline, landscape, rotated] = cells as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (text !== 'text' && text !== 'scanned' && text !== 'partial') {
      throw new Error(`SOURCES.md: "${text}" is not a text status (${name}).`);
    }
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`SOURCES.md: bad SHA-256 for ${name}.`);
    rows.push({
      file: name,
      path: path.join(REAL_PDF_DIR, name),
      pages: Number(pages),
      bytes: Number(bytes.replace(/[,_ ]/g, '')),
      sha256: sha,
      text,
      outline: Number(outline),
      landscape: Number(landscape),
      rotated: Number(rotated),
    });
  }
  return rows;
}

export function readRealPdfs(): RealPdf[] {
  return parseManifest(fs.readFileSync(path.join(REAL_PDF_DIR, 'SOURCES.md'), 'utf8'));
}

/** Test-title friendly: the matrix role of each file lives in SOURCES.md, the id is the file stem. */
export const stemOf = (pdf: RealPdf): string => pdf.file.replace(/\.pdf$/, '');

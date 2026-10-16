import { describe, expect, it } from 'vitest';
import { CaptureMethod } from '@shared';
import { describeCaptureMethod, formatDateTime } from './format';

describe('describeCaptureMethod', () => {
  it('has a plain-language label for every way a highlight can have been captured', () => {
    for (const method of CaptureMethod.options) {
      expect(describeCaptureMethod(method), method).not.toBe(method);
    }
  });

  it('names the file format of an import from customFields.importedFrom', () => {
    const labels = {
      markdown: 'a Markdown import',
      csv: 'a CSV import',
      anki: 'an Anki text import',
      docx: 'a Word document import',
      pptx: 'a PowerPoint import',
      epub: 'an EPUB import',
      html: 'an HTML import',
    };
    for (const [importedFrom, label] of Object.entries(labels)) {
      expect(
        describeCaptureMethod('import', { importedFrom, needsReview: true }),
        importedFrom,
      ).toBe(label);
    }
  });

  it('falls back to a generic import when the format is missing, unknown or not text', () => {
    expect(describeCaptureMethod('import')).toBe('a file import');
    expect(describeCaptureMethod('import', {})).toBe('a file import');
    expect(describeCaptureMethod('import', { importedFrom: 'file' })).toBe('a file import');
    expect(describeCaptureMethod('import', { importedFrom: 'constructor' })).toBe('a file import');
    expect(describeCaptureMethod('import', { importedFrom: 3 })).toBe('a file import');
  });

  it('ignores importedFrom for a capture made on a page', () => {
    expect(describeCaptureMethod('toolbar', { importedFrom: 'csv' })).toBe('the selection toolbar');
  });
});

describe('formatDateTime', () => {
  it('formats a date and time with its zone, not the raw ISO string', () => {
    const iso = '2026-10-12T15:36:32.255Z';
    const text = formatDateTime(iso);
    expect(text).not.toBe(iso);
    expect(text).toContain('2026');
  });

  it('keeps an unreadable value as it is', () => {
    expect(formatDateTime('not a date')).toBe('not a date');
  });
});

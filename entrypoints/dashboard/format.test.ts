import { describe, expect, it } from 'vitest';
import { CaptureMethod } from '@shared';
import { describeCaptureMethod } from './format';

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

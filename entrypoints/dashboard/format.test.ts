import { describe, expect, it } from 'vitest';
import { CaptureMethod } from '@shared';
import { describeCaptureMethod } from './format';

describe('describeCaptureMethod', () => {
  it('has a plain-language label for every way a highlight can have been captured', () => {
    for (const method of CaptureMethod.options) {
      expect(describeCaptureMethod(method), method).not.toBe(method);
    }
    expect(describeCaptureMethod('import')).toBe('a Markdown or CSV import');
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = __dirname;

const sources = fs
  .readdirSync(DIR)
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.|^test[A-Z]/.test(f))
  .map((f) => ({ file: f, text: fs.readFileSync(path.join(DIR, f), 'utf8') }));

describe('overlay source hygiene (page data is untrusted)', () => {
  it('finds the production sources', () => {
    expect(sources.length).toBeGreaterThanOrEqual(8);
  });

  it('never parses markup or builds URLs from strings', () => {
    const forbidden =
      /dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|DOMParser|\beval\(|new Function\(|\bhref=|\bsrc=|javascript:/;
    for (const { file, text } of sources) {
      // Comments may mention the words; code may not use them.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, file).not.toMatch(forbidden);
    }
  });

  it('has no free-text control: page scripts observe keystrokes typed in the page', () => {
    // Text is typed in the side panel (extension origin). Only <select> pickers may live here.
    const freeText =
      /<textarea|<input\b|contentEditable|contenteditable|role="(?:textbox|searchbox)"|type="(?:text|search|password|email|url|tel)"/;
    for (const { file, text } of sources) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, file).not.toMatch(freeText);
    }
  });

  it('keeps layout units in px (host pages change rem)', () => {
    const css = fs.readFileSync(path.join(DIR, 'styles.css'), 'utf8');
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutComments).not.toMatch(/\d(rem|em)\b/);
  });
});

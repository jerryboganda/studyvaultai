import { afterEach, describe, expect, it } from 'vitest';
import { MAX_TITLE_CHARS, MAX_URL_CHARS } from '@shared';
import { canonicalHref, fitUrl, readPageInfo } from './page';
import { setBody } from './testUtils';

afterEach(() => {
  document.head.innerHTML = '';
  document.title = '';
  setBody('');
});

describe('fitUrl', () => {
  it('passes ordinary http(s) addresses through', () => {
    expect(fitUrl('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
  });

  it('rejects other schemes', () => {
    expect(fitUrl('javascript:alert(1)')).toBeNull();
    expect(fitUrl('file:///etc/passwd')).toBeNull();
    expect(fitUrl('not a url')).toBeNull();
  });

  it('drops the fragment, then the query, until it fits', () => {
    const long = 'x'.repeat(MAX_URL_CHARS);
    expect(fitUrl(`https://example.com/p?q=1#${long}`)).toBe('https://example.com/p?q=1');
    expect(fitUrl(`https://example.com/p?q=${long}#h`)).toBe('https://example.com/p');
  });

  it('gives up when the path alone is too long', () => {
    expect(fitUrl(`https://example.com/${'p'.repeat(MAX_URL_CHARS)}`)).toBeNull();
  });
});

describe('canonicalHref', () => {
  it('resolves a relative canonical against the document base', () => {
    document.head.innerHTML = '<link rel="canonical" href="/articles/42">';
    expect(canonicalHref(document)).toBe(new URL('/articles/42', document.baseURI).href);
  });

  it('accepts several rel tokens and any case', () => {
    document.head.innerHTML = '<link rel="Alternate CANONICAL" href="https://example.com/x">';
    expect(canonicalHref(document)).toBe('https://example.com/x');
  });

  it('ignores non-canonical links, empty hrefs and non-http schemes', () => {
    document.head.innerHTML =
      '<link rel="stylesheet" href="/a.css">' +
      '<link rel="canonical" href="">' +
      '<link rel="canonical" href="javascript:alert(1)">' +
      '<link rel="canonical" href="https://example.com/real">';
    expect(canonicalHref(document)).toBe('https://example.com/real');
  });

  it('is null when there is no canonical link', () => {
    document.head.innerHTML = '<link rel="icon" href="/f.ico">';
    expect(canonicalHref(document)).toBeNull();
  });
});

describe('readPageInfo', () => {
  it('collects url, canonical and title', () => {
    document.head.innerHTML = '<link rel="canonical" href="https://example.com/c">';
    document.title = '  A Study Page  ';
    expect(readPageInfo(document, 'https://example.com/p')).toEqual({
      url: 'https://example.com/p',
      canonicalUrl: 'https://example.com/c',
      title: 'A Study Page',
    });
  });

  it('clips an over-long title without splitting a surrogate pair', () => {
    document.title = `${'a'.repeat(MAX_TITLE_CHARS - 1)}😀tail`;
    const info = readPageInfo(document, 'https://example.com/p')!;
    expect(info.title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(info.title).toBe('a'.repeat(MAX_TITLE_CHARS - 1));
  });

  it('falls back to the host when the page has no title', () => {
    document.title = '';
    expect(readPageInfo(document, 'https://example.com/p')!.title).toBe('example.com');
  });

  it('is null for an address that cannot be stored', () => {
    expect(readPageInfo(document, 'about:blank')).toBeNull();
  });
});

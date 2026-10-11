import { describe, expect, it } from 'vitest';
import { parseQuery } from '@search';
import {
  appendTokens,
  facetToken,
  hasFacetToken,
  scopeTokens,
  toggleFacetToken,
} from './queryTokens';

describe('facet tokens', () => {
  it('quotes values so names with spaces, quotes and backslashes stay one token', () => {
    expect(facetToken('bank', 'Cardiology')).toBe('bank:"Cardiology"');
    expect(facetToken('tag', 'exam pearl')).toBe('tag:"exam pearl"');
    expect(facetToken('tag', 'say "hi"')).toBe('tag:"say \\"hi\\""');
    expect(facetToken('folder', 'a\\b')).toBe('folder:"a\\\\b"');
  });

  it('toggles a token on and off without leaving stray spaces', () => {
    const on = toggleFacetToken('valve', 'kind', 'formula');
    expect(on).toBe('valve kind:"formula"');
    expect(hasFacetToken(on, 'kind', 'formula')).toBe(true);
    expect(toggleFacetToken(on, 'kind', 'formula')).toBe('valve');
    expect(toggleFacetToken('', 'tag', 'neuro')).toBe('tag:"neuro"');
    expect(toggleFacetToken('tag:"neuro"', 'tag', 'neuro')).toBe('');
  });

  it('groups a typed OR so the appended filter applies to both sides', () => {
    expect(appendTokens('mitral OR aortic', ['bank:"Heart"'])).toBe(
      '(mitral OR aortic) bank:"Heart"',
    );
    expect(appendTokens('(mitral OR aortic)', ['bank:"Heart"'])).toBe(
      '(mitral OR aortic) bank:"Heart"',
    );
    const parsed = parseQuery(appendTokens('mitral OR aortic', ['bank:"Heart"']));
    expect(parsed.warnings).toEqual([]);
    expect(parsed.root?.type).toBe('and');
  });

  it('removing the token ungroups the query it had grouped', () => {
    const grouped = toggleFacetToken('mitral OR aortic', 'bank', 'Heart');
    expect(grouped).toBe('(mitral OR aortic) bank:"Heart"');
    expect(toggleFacetToken(grouped, 'bank', 'Heart')).toBe('mitral OR aortic');
  });

  it('builds the scope tokens for a bank and an optional folder', () => {
    expect(scopeTokens(null)).toEqual([]);
    expect(scopeTokens({ bankName: 'Biology', folderName: null })).toEqual(['bank:"Biology"']);
    expect(scopeTokens({ bankName: 'Biology', folderName: 'Cell' })).toEqual([
      'bank:"Biology"',
      'folder:"Cell"',
    ]);
    expect(appendTokens('', ['bank:"Biology"'])).toBe('bank:"Biology"');
    expect(appendTokens('  x ', [])).toBe('x');
  });
});

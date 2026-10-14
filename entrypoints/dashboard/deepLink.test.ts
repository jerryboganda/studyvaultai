import { describe, expect, it } from 'vitest';
import { MAX_QUERY_LENGTH } from '@search';
import { dashboardPath, initialView, parseDeepLink, parseViewLink } from './deepLink';
import { textFragment, webSourceHref } from './links';

describe('parseDeepLink', () => {
  it('reads highlight, bank and query', () => {
    expect(parseDeepLink('?highlight=0192abcd-ef01&bank=inbox-default&q=cell%20membrane')).toEqual({
      highlight: '0192abcd-ef01',
      bank: 'inbox-default',
      q: 'cell membrane',
    });
  });

  it('ignores ids that do not look like ids, and empty queries', () => {
    expect(parseDeepLink('?highlight=a&bank=<script>alert(1)</script>&q=%20%20')).toEqual({
      highlight: null,
      bank: null,
      q: null,
    });
    expect(parseDeepLink('')).toEqual({ highlight: null, bank: null, q: null });
  });

  it('bounds the query', () => {
    const q = 'x'.repeat(MAX_QUERY_LENGTH + 100);
    expect(parseDeepLink(`?q=${q}`).q).toHaveLength(MAX_QUERY_LENGTH);
  });

  it('builds the path the other surfaces use to open the dashboard', () => {
    expect(dashboardPath()).toBe('dashboard.html');
    expect(dashboardPath({ highlight: '0192abcd-ef01', q: 'a b' })).toBe(
      'dashboard.html?highlight=0192abcd-ef01&q=a+b',
    );
  });
});

describe('parseViewLink', () => {
  it('reads the views that have an address and ignores anything else', () => {
    expect(parseViewLink('?view=chat&bank=inbox-default')).toBe('chat');
    expect(parseViewLink('?view=trash')).toBe('trash');
    expect(parseViewLink('?view=library')).toBe('library');
    expect(parseViewLink('?view=<script>')).toBeNull();
    expect(parseViewLink('')).toBeNull();
  });

  it('opens Home by default and the list for a highlight, bank or query link', () => {
    expect(initialView('')).toBe('home');
    expect(initialView('?view=nope')).toBe('home');
    expect(initialView('?bank=inbox-default')).toBe('library');
    expect(initialView('?q=golgi')).toBe('library');
    expect(initialView('?highlight=0192abcd-ef01')).toBe('library');
    expect(initialView('?view=more&q=golgi')).toBe('more');
  });

  it('opens the graph for view=graph, around the highlight of the link', () => {
    expect(parseViewLink('?view=graph&highlight=0192abcd-ef01')).toBe('graph');
    expect(parseDeepLink('?view=graph&highlight=0192abcd-ef01').highlight).toBe('0192abcd-ef01');
    expect(dashboardPath({ highlight: '0192abcd-ef01', view: 'graph' })).toBe(
      'dashboard.html?highlight=0192abcd-ef01&view=graph',
    );
  });

  it('is part of the link other surfaces build', () => {
    expect(dashboardPath({ bank: 'inbox-default', view: 'chat' })).toBe(
      'dashboard.html?bank=inbox-default&view=chat',
    );
    expect(dashboardPath({ view: null })).toBe('dashboard.html');
  });
});

describe('opening the original at the passage', () => {
  it('adds a text fragment and keeps an existing hash in front of it', () => {
    expect(webSourceHref('https://example.com/page', 'Cell membrane')).toBe(
      'https://example.com/page#:~:text=Cell%20membrane',
    );
    expect(webSourceHref('https://example.com/page#intro', 'Cell membrane')).toBe(
      'https://example.com/page#intro:~:text=Cell%20membrane',
    );
  });

  it('addresses a long quote by its first and last words', () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`);
    const fragment = textFragment(words.join(' '));
    expect(fragment).toBe(
      'text=word0%20word1%20word2%20word3%20word4,word55%20word56%20word57%20word58%20word59',
    );
  });

  it('encodes the characters that are special in a directive', () => {
    expect(textFragment('a-b, c&d')).toBe('text=a%2Db%2C%20c%26d');
  });

  it('has no address for pages that cannot be reached', () => {
    expect(webSourceHref('javascript:alert(1)', 'x')).toBeUndefined();
    expect(webSourceHref('https://studyvault.invalid/pdf/abc', 'x')).toBeUndefined();
    expect(webSourceHref(null, 'x')).toBeUndefined();
    expect(webSourceHref('ftp://example.com/x', 'x')).toBeUndefined();
  });
});

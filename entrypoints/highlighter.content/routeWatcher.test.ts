import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RouteWatcher } from './routeWatcher';

function fakeWindow(withNavigation: boolean) {
  const target = new EventTarget();
  const loc = { href: 'https://example.com/a' };
  const nav = withNavigation ? new EventTarget() : undefined;
  const win = {
    location: loc,
    navigation: nav,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as ConstructorParameters<typeof RouteWatcher>[0];
  return { win, loc, nav, target };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('RouteWatcher', () => {
  it('reports a Navigation API route change once, after the URL has been applied', () => {
    const { win, loc, nav } = fakeWindow(true);
    const seen: string[] = [];
    const w = new RouteWatcher(win, (href) => seen.push(href));
    w.start();

    nav!.dispatchEvent(new Event('navigate')); // URL not committed yet
    expect(seen).toEqual([]);
    loc.href = 'https://example.com/b';
    vi.runAllTimers();
    expect(seen).toEqual(['https://example.com/b']);

    nav!.dispatchEvent(new Event('navigatesuccess')); // same URL again: no second report
    expect(seen).toHaveLength(1);
  });

  it('falls back to popstate/hashchange without the Navigation API', () => {
    const { win, loc, target } = fakeWindow(false);
    const seen: string[] = [];
    new RouteWatcher(win, (href) => seen.push(href)).start();
    loc.href = 'https://example.com/#/route-2';
    target.dispatchEvent(new Event('hashchange'));
    expect(seen).toEqual(['https://example.com/#/route-2']);
  });

  it('check() covers pushState, which fires no event', () => {
    const { win, loc } = fakeWindow(false);
    const seen: Array<[string, string]> = [];
    const w = new RouteWatcher(win, (href, prev) => seen.push([href, prev]));
    w.start();
    expect(w.check()).toBe(false);
    loc.href = 'https://example.com/next';
    expect(w.check()).toBe(true);
    expect(w.check()).toBe(false);
    expect(seen).toEqual([['https://example.com/next', 'https://example.com/a']]);
  });

  it('ignores plain anchor jumps and tracking parameters', () => {
    const { win, loc } = fakeWindow(false);
    const onChange = vi.fn();
    const w = new RouteWatcher(win, onChange);
    loc.href = 'https://example.com/a#section-2';
    expect(w.check()).toBe(false);
    loc.href = 'https://example.com/a?utm_source=x';
    expect(w.check()).toBe(false);
    loc.href = 'https://example.com/a?page=2';
    expect(w.check()).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('treats hash routes as routes', () => {
    const { win, loc } = fakeWindow(false);
    const w = new RouteWatcher(win, vi.fn());
    loc.href = 'https://example.com/a#/inbox';
    expect(w.check()).toBe(true);
  });

  it('stop() removes every listener and the pending check', () => {
    const { win, loc, nav, target } = fakeWindow(true);
    const onChange = vi.fn();
    const w = new RouteWatcher(win, onChange);
    w.start();
    nav!.dispatchEvent(new Event('navigate'));
    w.stop();
    loc.href = 'https://example.com/zzz';
    vi.runAllTimers();
    nav!.dispatchEvent(new Event('navigatesuccess'));
    target.dispatchEvent(new Event('popstate'));
    target.dispatchEvent(new Event('hashchange'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

import { normalizeUrl } from '@shared';

interface NavigationLike {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

type RouteWindow = Pick<Window, 'addEventListener' | 'removeEventListener' | 'location'> & {
  navigation?: NavigationLike;
};

const identity = (href: string): string => normalizeUrl(href) ?? href;

/**
 * Detects single-page-app route changes. The Navigation API (`navigate`, `navigatesuccess`) is
 * primary; `popstate`/`hashchange` and `check()` (called from the MutationObserver callback) cover
 * `history.pushState` where the Navigation API is missing. All paths compare the page IDENTITY
 * (`normalizeUrl`: no tracking params, no plain `#section` fragment), so an in-page anchor jump is
 * not a route change and a real change is reported exactly once.
 */
export class RouteWatcher {
  private last: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listener = (): void => {
    this.check();
  };
  /** `navigate` fires before the URL commits; look again once the navigation has been applied. */
  private readonly early = (): void => {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.check();
    }, 0);
  };

  constructor(
    private readonly win: RouteWindow,
    private readonly onChange: (href: string, previous: string) => void,
  ) {
    this.last = identity(win.location.href);
  }

  start(): void {
    const nav = this.win.navigation;
    if (nav) {
      nav.addEventListener('navigate', this.early);
      nav.addEventListener('navigatesuccess', this.listener);
    }
    this.win.addEventListener('popstate', this.listener);
    this.win.addEventListener('hashchange', this.listener);
  }

  /** Returns true when the address changed since the previous check. */
  check(): boolean {
    const href = this.win.location.href;
    const next = identity(href);
    if (next === this.last) return false;
    const previous = this.last;
    this.last = next;
    this.onChange(href, previous);
    return true;
  }

  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const nav = this.win.navigation;
    if (nav) {
      nav.removeEventListener('navigate', this.early);
      nav.removeEventListener('navigatesuccess', this.listener);
    }
    this.win.removeEventListener('popstate', this.listener);
    this.win.removeEventListener('hashchange', this.listener);
  }
}

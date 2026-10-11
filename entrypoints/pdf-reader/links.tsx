import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  destinationPoint,
  popBack,
  pushBack,
  type PageLink,
  type PageLinks,
  type PdfDocument,
  type ViewPosition,
} from '@pdf';
import { Button, ConfirmDialog, InlineNotice, plural, useLatest } from '@ui';
import type { ViewerHandle } from './Viewer';

/**
 * What a followed link does in the reader (ADR-006, Amendment 3).
 *
 * - A place in this document: the view goes there, the page takes keyboard focus, "Went to page N" is
 *   said, and where the person was goes on the Back stack (the Back button, Alt+Left).
 * - An address: nothing opens until the person confirms in a dialog that shows the whole address and
 *   the site. It opens in a NEW tab with `noopener,noreferrer`. "Always allow this site" is off and
 *   lasts only until the reader page is closed.
 * - Anything else (a refused scheme, a script, a file): a notice that says why. Nothing runs.
 */

/** Opens an address in a new tab that gets no handle to this page and no referrer. */
export function openInNewTab(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

type ExternalTarget = Extract<PageLink['target'], { kind: 'external' }>;

export interface LinkController {
  /** Follow a link (from a page, or from the Links list). */
  follow(link: PageLink): void;
  /** Return to where the last followed link was clicked. */
  back(): void;
  /** The page Back returns to; null when no link has been followed. */
  backTo: number | null;
  /** The confirmation dialog (null unless an address is waiting for an answer). */
  dialog: ReactNode;
  /** Why the last link was not followed (null when it was, or after Dismiss). */
  notice: ReactNode;
}

export function useLinks({
  doc,
  viewer,
  onPage,
  announce,
  open = openInNewTab,
}: {
  doc: Pick<PdfDocument, 'getPage'>;
  viewer: RefObject<ViewerHandle | null>;
  onPage(pageNumber: number): void;
  /** Say something through the surface's polite status region. */
  announce(message: string): void;
  open?(url: string): void;
}): LinkController {
  const stack = useRef<ViewPosition[]>([]);
  const [backTo, setBackTo] = useState<number | null>(null);
  const [asking, setAsking] = useState<ExternalTarget | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  // Origins the person allowed for this page load only. Never persisted.
  const allowed = useRef(new Set<string>());
  const latest = useLatest({ onPage, announce, open });

  const goTo = useCallback(
    (t: { pageNumber: number; left: number | null; top: number | null }) => {
      const handle = viewer.current;
      if (!handle) return;
      const from = handle.position();
      doc.getPage(t.pageNumber).then(
        (p) => {
          stack.current = pushBack(stack.current, from);
          setBackTo(stack.current[stack.current.length - 1]?.page ?? null);
          handle.goToDestination(t.pageNumber, destinationPoint(p.view, t.left, t.top));
          latest.current.onPage(t.pageNumber);
          latest.current.announce(`Went to page ${t.pageNumber}.`);
        },
        () => setRefusal('This link points to a page that could not be read.'),
      );
    },
    [doc, latest, viewer],
  );

  const follow = useCallback(
    (link: PageLink) => {
      setRefusal(null);
      const t = link.target;
      if (t.kind === 'refused') {
        setRefusal(t.reason);
      } else if (t.kind === 'page') {
        goTo(t);
      } else if (allowed.current.has(t.origin)) {
        latest.current.open(t.url);
        latest.current.announce(`Opening ${t.host} in a new tab.`);
      } else {
        setAsking(t);
      }
    },
    [goTo, latest],
  );

  const back = useCallback(() => {
    const { to, stack: rest } = popBack(stack.current);
    if (!to) {
      latest.current.announce('Nothing to go back to: no link has been followed yet.');
      return;
    }
    stack.current = rest;
    setBackTo(rest[rest.length - 1]?.page ?? null);
    viewer.current?.restore(to);
    latest.current.onPage(to.page);
    latest.current.announce(`Back on page ${to.page}.`);
  }, [latest, viewer]);

  // Alt+Left is Back. The browser would otherwise leave the reader (and the open document with it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowLeft' || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      back();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [back]);

  const dialog = asking ? (
    <ExternalLinkDialog
      target={asking}
      onConfirm={(always) => {
        // Runs from the click: window.open needs the gesture, so nothing is awaited before it.
        if (always) allowed.current.add(asking.origin);
        setAsking(null);
        latest.current.open(asking.url);
        latest.current.announce(`Opening ${asking.host} in a new tab.`);
      }}
      onCancel={() => setAsking(null)}
    />
  ) : null;

  const notice = refusal ? (
    <InlineNotice
      tone="warning"
      live
      title="Link not opened"
      action={<Button onClick={() => setRefusal(null)}>Dismiss</Button>}
    >
      <p data-testid="pdf-link-notice">{refusal}</p>
    </InlineNotice>
  ) : null;

  return { follow, back, backTo, dialog, notice };
}

function ExternalLinkDialog({
  target,
  onConfirm,
  onCancel,
}: {
  target: ExternalTarget;
  onConfirm(always: boolean): void;
  onCancel(): void;
}) {
  const [always, setAlways] = useState(false);
  return (
    <ConfirmDialog
      title="Open this link in a new tab?"
      confirmLabel="Open in a new tab"
      onConfirm={() => onConfirm(always)}
      onCancel={onCancel}
    >
      <p>This PDF links to a web site. Nothing is opened until you say so.</p>
      <dl className="sv-props__list" data-testid="pdf-link-dialog">
        <div>
          <dt>Address</dt>
          <dd data-testid="pdf-link-address">{target.url}</dd>
        </div>
        <div>
          <dt>Site</dt>
          <dd data-testid="pdf-link-host">{target.host}</dd>
        </div>
      </dl>
      <label className="sv-check sv-linkallow">
        <input
          type="checkbox"
          checked={always}
          data-testid="pdf-link-always"
          onChange={(e) => setAlways(e.target.checked)}
        />
        <span>
          Always allow this site ({target.host}) in this reader session. Closing the reader forgets
          it.
        </span>
      </label>
      <p className="sv-small sv-muted">
        It opens in a new tab and is not told which page you came from.
      </p>
    </ConfirmDialog>
  );
}

const SHOWN_ADDRESS = 90;

/** The "Links on this page" list: the accessible primary way through a page with many links. */
export function LinkList({
  links,
  pageNumber,
  onFollow,
}: {
  /** null while the page's links are being read. */
  links: PageLinks | null;
  pageNumber: number;
  onFollow(link: PageLink): void;
}) {
  if (links === null) {
    return (
      <p className="sv-muted" role="status">
        Reading the links…
      </p>
    );
  }
  if (links.links.length === 0) {
    return (
      <p className="sv-muted" data-testid="pdf-links-empty">
        Page {pageNumber} has no links.
      </p>
    );
  }
  return (
    <>
      <p className="sv-label">Links on this page</p>
      <ul className="sv-outline" aria-label="Links on this page" data-testid="pdf-links-list">
        {links.links.map((link, i) => {
          const t = link.target;
          const detail =
            t.kind === 'external'
              ? t.url.length > SHOWN_ADDRESS
                ? `${t.url.slice(0, SHOWN_ADDRESS)}…`
                : t.url
              : t.kind === 'refused'
                ? 'will not be opened'
                : null;
          return (
            <li key={i}>
              <Button
                variant="ghost"
                title={t.kind === 'external' ? t.url : undefined}
                onClick={() => onFollow(link)}
              >
                <span>{link.label}</span>
                {detail ? <span className="sv-muted sv-small"> · {detail}</span> : null}
              </Button>
            </li>
          );
        })}
      </ul>
      {links.omitted > 0 ? (
        <p className="sv-small sv-muted">
          {plural(links.omitted, 'more link')} on this page {links.omitted === 1 ? 'is' : 'are'} not
          listed.
        </p>
      ) : null}
    </>
  );
}

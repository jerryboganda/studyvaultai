// In-page toolbar on a sample article. The toolbar and the toast render inside open shadow roots
// with their own adopted stylesheet (CSP-safe) and the system rounded font, so no extension file
// is exposed to the page. Saved passages are painted with the CSS Custom Highlight API: the
// article markup never changes. (Product: one closed shadow root; open here for the mockup.)
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal, flushSync } from 'react-dom';
import {
  Bookmark,
  Check,
  ChevronDown,
  CircleCheck,
  Lock,
  StickyNote,
  Undo2,
  X,
  Zap,
} from 'lucide-react';
import toolbarCss from '../toolbar.css?inline';
import { BANKS, KINDS, bankOf, type Kind } from '../data';
import { LogoMark } from '../VaultBuddy';

const canPaint = typeof CSS !== 'undefined' && 'highlights' in CSS;
const SEL = 'sv-sel';
const SEED = 'which raises the pressure the heart has to pump against';
const SAVED = 'the heart cannot pump enough blood to meet the body’s needs';

let sheet: CSSStyleSheet | null = null;
const toolbarSheet = () => {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(toolbarCss);
  }
  return sheet;
};

/** Attach (or reuse) an open shadow root and return a mount node inside it. */
function useShadow() {
  const [mount, setMount] = useState<HTMLElement | null>(null);
  const ref = (host: HTMLElement | null) => {
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [toolbarSheet()];
    let node = root.querySelector<HTMLElement>('.tb-root');
    if (!node) {
      node = document.createElement('div');
      node.className = 'tb-root';
      root.append(node);
    }
    setMount(node);
  };
  return [ref, mount] as const;
}

function findRange(root: HTMLElement, text: string): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const at = n.textContent?.indexOf(text) ?? -1;
    if (at >= 0) {
      const r = document.createRange();
      r.setStart(n, at);
      r.setEnd(n, at + text.length);
      return r;
    }
  }
  return null;
}

const paint = (name: string, add?: Range, remove?: Range) => {
  if (!canPaint) return;
  const h = CSS.highlights.get(name) ?? new Highlight();
  if (remove) h.delete(remove);
  if (add) h.add(add);
  CSS.highlights.set(name, h);
};

type Pos = { x: number; y: number; below: boolean };
type Saved = { range: Range; kind: Kind; bank: string; note: boolean };

export function InPage({ theme }: { theme: 'light' | 'dark' | 'system' }) {
  const scroller = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement | null>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const undoBtn = useRef<HTMLButtonElement>(null);
  const [tbRef, tbMount] = useShadow();
  const [toastRef, toastMount] = useShadow();
  const [range, setRange] = useState<Range | null>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  const [bank, setBank] = useState('cardio');
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState<Saved | null>(null);

  const place = (r: Range) => {
    // The scroller is the article's parent; read it from there (child refs attach first).
    const wrap = article.current?.parentElement;
    if (!wrap) return;
    const box = wrap.getBoundingClientRect();
    const rect = r.getClientRects()[0] ?? r.getBoundingClientRect();
    const below = rect.top - box.top < 80;
    const x = Math.min(Math.max(rect.left + rect.width / 2 - box.left, 230), box.width - 230);
    const y = (below ? rect.bottom : rect.top) - box.top + wrap.scrollTop + (below ? 12 : -12);
    setPos({ x, y, below });
  };
  const select = (r: Range) => {
    paint(SEL, r, range ?? undefined);
    setRange(r);
    setMenu(false);
    place(r);
  };

  // Paint one earlier save and offer the demo selection once the article is in the DOM. A new
  // article element means a fresh mount (Reset demo), so clear what the last one painted.
  const articleRef = (el: HTMLElement | null) => {
    if (!el || article.current === el) return;
    article.current = el;
    if (canPaint)
      for (const name of [SEL, ...KINDS.map((k) => `sv-${k.tone}`)]) CSS.highlights.delete(name);
    const old = findRange(el, SAVED);
    if (old) paint('sv-mint', old);
    const seed = findRange(el, SEED);
    if (seed) select(seed);
  };

  // The toast leaves on its own after a few seconds.
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const onMouseUp = () => {
    const s = window.getSelection();
    if (!s || s.isCollapsed || !s.rangeCount || !article.current?.contains(s.anchorNode)) return;
    const r = s.getRangeAt(0).cloneRange();
    s.removeAllRanges();
    select(r);
  };

  const dismiss = () => {
    if (range) paint(SEL, undefined, range);
    setRange(null);
    setMenu(false);
    scroller.current?.focus();
  };

  const save = (kind: Kind, note: boolean, e: MouseEvent) => {
    if (!range) return;
    const fromKeyboard = e.detail === 0;
    paint(SEL, undefined, range);
    paint(`sv-${kind.tone}`, range);
    flushSync(() => {
      setToast({ range, kind, bank, note });
      setRange(null);
      setMenu(false);
    });
    if (fromKeyboard) undoBtn.current?.focus();
  };

  const undo = () => {
    if (!toast) return;
    paint(`sv-${toast.kind.tone}`, undefined, toast.range);
    const r = toast.range;
    setToast(null);
    select(r);
  };

  const onToolbarKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (menu) {
        setMenu(false);
        chip.current?.focus();
      } else dismiss();
      return;
    }
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    if ((e.target as HTMLElement).closest('[role="menu"]')) return;
    const items = [
      ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
        ':scope > button, :scope > div > button',
      ),
    ];
    const i = items.indexOf(e.target as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    items[(i + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length]?.focus();
  };

  const toggleMenu = () => {
    if (menu) return setMenu(false);
    flushSync(() => setMenu(true));
    tbMount?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [
      ...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ];
    const i = items.indexOf(e.target as HTMLButtonElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  };

  const current = bankOf(bank);
  const BankIcon = current.icon;
  const hostTheme = theme === 'system' ? undefined : theme;

  return (
    <div className="ip">
      <div className="ip-chrome">
        <span className="ip-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="ip-url">
          <Lock aria-hidden="true" strokeWidth={2.6} />
          openmed.example.org/heart-failure
        </span>
      </div>
      <div
        className="ip-scroll"
        ref={scroller}
        role="region"
        aria-label="Sample web page"
        tabIndex={0}
      >
        <article
          className="ip-article"
          ref={articleRef}
          aria-label="Sample article"
          onMouseUp={onMouseUp}
        >
          <p className="ip-kicker">Cardiology basics</p>
          <h3 className="ip-title">Heart failure: an overview</h3>
          <p className="ip-by">Sample article for the mockup · 6 min read</p>
          <p>
            Heart failure means the heart cannot pump enough blood to meet the body’s needs. It
            rarely starts suddenly. Most often it follows years of strain from a heart attack, a
            leaky valve or long-standing high blood pressure.
          </p>
          <p>
            In high blood pressure the arteries stiffen, which raises the pressure the heart has to
            pump against. The left ventricle thickens to cope, but a thick wall relaxes poorly and
            fills less between beats.
          </p>
          <p>
            Breathlessness, swollen ankles and tiredness are the usual signs. They come from fluid
            backing up behind a weak pump: into the lungs from the left side, and into the legs and
            belly from the right.
          </p>
          <p>
            Treatment aims to ease symptoms and slow the disease. Diuretics clear extra fluid, while
            other medicines lower the work of the heart and protect it from further remodelling over
            time.
          </p>
        </article>

        <div className="ip-host" ref={tbRef} data-theme={hostTheme} />
        {tbMount &&
          range &&
          pos &&
          createPortal(
            <div
              className="tb"
              data-below={pos.below || undefined}
              role="toolbar"
              aria-label="StudyVault"
              style={{ left: pos.x, top: pos.y }}
              onKeyDown={onToolbarKey}
            >
              <span className="tb-logo" aria-hidden="true">
                <LogoMark size={24} />
              </span>
              <div className="tb-dots" role="group" aria-label="Save as">
                {KINDS.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    className="tb-dot tb-tip"
                    data-tone={k.tone}
                    data-tip={k.label}
                    aria-label={`Save as ${k.label}`}
                    onClick={(e) => save(k, false, e)}
                  >
                    <span />
                  </button>
                ))}
              </div>
              <span className="tb-sep" aria-hidden="true" />
              <button type="button" className="tb-save" onClick={(e) => save(KINDS[0]!, false, e)}>
                <Bookmark aria-hidden="true" strokeWidth={2.6} />
                Save
              </button>
              <button
                type="button"
                className="tb-icon tb-tip"
                data-tip="Save + note"
                aria-label="Save and add a note"
                onClick={(e) => save(KINDS[0]!, true, e)}
              >
                <StickyNote aria-hidden="true" strokeWidth={2.4} />
              </button>
              <div className="tb-bank">
                <button
                  ref={chip}
                  type="button"
                  className="tb-chip"
                  data-tone={current.tone}
                  aria-haspopup="menu"
                  aria-expanded={menu}
                  aria-label={`Bank: ${current.name}`}
                  onClick={toggleMenu}
                >
                  <BankIcon aria-hidden="true" strokeWidth={2.6} />
                  <span>{current.name}</span>
                  <ChevronDown aria-hidden="true" strokeWidth={2.6} />
                </button>
                {menu && (
                  <div
                    className="tb-menu"
                    role="menu"
                    aria-label="Save to bank"
                    onKeyDown={onMenuKey}
                  >
                    {BANKS.map((b) => {
                      const I = b.icon;
                      return (
                        <button
                          key={b.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={b.id === bank}
                          data-tone={b.tone}
                          onClick={() => {
                            setBank(b.id);
                            setMenu(false);
                            chip.current?.focus();
                          }}
                        >
                          <span className="tb-menu__well">
                            <I aria-hidden="true" strokeWidth={2.4} />
                          </span>
                          {b.name}
                          {b.id === bank && (
                            <Check aria-hidden="true" className="tb-menu__check" strokeWidth={3} />
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="tb-icon tb-tip"
                data-tip="Close (Esc)"
                aria-label="Close"
                onClick={dismiss}
              >
                <X aria-hidden="true" strokeWidth={2.6} />
              </button>
            </div>,
            tbMount,
          )}
      </div>

      <div className="ip-toasthost" ref={toastRef} data-theme={hostTheme} />
      {toastMount &&
        createPortal(
          <div className="tb-toastzone" role="status">
            {toast && (
              <div className="tb-toast">
                <span className="tb-toast__ok" data-tone={toast.kind.tone}>
                  <CircleCheck aria-hidden="true" strokeWidth={2.6} />
                </span>
                <span className="tb-toast__text">
                  <strong>Saved</strong> to {bankOf(toast.bank).name}
                  {toast.note && <span className="tb-toast__sub">Note opens in panel</span>}
                </span>
                <span className="tb-xp">
                  <Zap aria-hidden="true" strokeWidth={2.8} />
                  +2 XP
                </span>
                <button ref={undoBtn} type="button" className="tb-undo" onClick={undo}>
                  <Undo2 aria-hidden="true" strokeWidth={2.6} />
                  Undo
                </button>
              </div>
            )}
          </div>,
          toastMount,
        )}
      {!range && !toast && (
        <p className="ip-hint" aria-hidden="true">
          Select any text to save it
        </p>
      )}
    </div>
  );
}

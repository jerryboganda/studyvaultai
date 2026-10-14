// In-page selection toolbar on a sample article. The toolbar and toast live in an open shadow root
// with their own stylesheet (adoptedStyleSheets, CSP-safe) and the system rounded font stack.
// Saved passages are painted with the CSS Custom Highlight API, so the page markup never changes.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  ChevronDown,
  CircleCheck,
  Lock,
  RotateCw,
  NotebookPen,
  Undo2,
  X,
  Zap,
} from 'lucide-react';
import toolbarCss from '../toolbar.css?inline';
import { BANKS, HL_COLOURS, type HlColour } from '../data';
import { LogoMark } from '../shared';

const canPaint = typeof CSS !== 'undefined' && 'highlights' in CSS;
const SEL = 'sv-sel';

type Saved = { range: Range; colour: HlColour; bank: string; note: boolean };

export function InPage({ theme }: { theme?: 'light' | 'dark' }) {
  const page = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);
  const target = useRef<HTMLSpanElement>(null);
  const firstBtn = useRef<HTMLButtonElement>(null);
  const [mount, setMount] = useState<HTMLDivElement | null>(null);
  const [range, setRange] = useState<Range | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [bank, setBank] = useState('cardio');
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState<Saved | null>(null);

  // Attach the shadow root when the host mounts; StrictMode may attach twice, so reuse it.
  const host = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(toolbarCss);
    root.adoptedStyleSheets = [sheet];
    const div = document.createElement('div');
    div.className = 'tb-root';
    root.append(div);
    setMount(div);
    return () => {
      div.remove();
      setMount(null);
    };
  }, []);

  const selectTarget = useCallback(() => {
    const node = target.current?.firstChild;
    if (!node) return;
    const r = document.createRange();
    r.selectNodeContents(node);
    setRange(r);
  }, []);

  useEffect(() => {
    selectTarget();
    return () => {
      if (!canPaint) return;
      CSS.highlights.delete(SEL);
      HL_COLOURS.forEach((c) => CSS.highlights.delete(`sv-${c.id}`));
    };
  }, [selectTarget]);

  // Paint the pending selection and place the toolbar above it.
  useLayoutEffect(() => {
    if (canPaint) {
      if (range) CSS.highlights.set(SEL, new Highlight(range));
      else CSS.highlights.delete(SEL);
    }
    if (!range || !page.current) {
      setPos(null);
      return;
    }
    const place = () => {
      if (!page.current) return;
      const box = page.current.getBoundingClientRect();
      const r = range.getBoundingClientRect();
      const half = 190;
      const x = Math.min(Math.max(r.left + r.width / 2 - box.left, half), box.width - half);
      setPos({ x, y: r.top - box.top });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(page.current);
    void document.fonts.ready.then(place);
    return () => ro.disconnect();
  }, [range]);

  const save = (colour: HlColour, note = false) => {
    if (!range) return;
    if (canPaint) {
      const h = CSS.highlights.get(`sv-${colour}`) ?? new Highlight();
      h.add(range);
      CSS.highlights.set(`sv-${colour}`, h);
    }
    setToast({ range, colour, bank, note });
    setRange(null);
    setMenu(false);
  };
  const undo = () => {
    if (toast && canPaint) CSS.highlights.get(`sv-${toast.colour}`)?.delete(toast.range);
    setToast(null);
    page.current?.focus();
  };
  const reset = () => {
    if (canPaint) HL_COLOURS.forEach((c) => CSS.highlights.delete(`sv-${c.id}`));
    setToast(null);
    selectTarget();
  };
  const onPick = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !article.current?.contains(sel.anchorNode)) return;
    setRange(sel.getRangeAt(0).cloneRange());
    sel.removeAllRanges();
    requestAnimationFrame(() => firstBtn.current?.focus());
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (menu) setMenu(false);
    else if (range) {
      setRange(null);
      page.current?.focus();
    }
  };
  const bankInfo = BANKS.find((b) => b.id === bank)!;

  return (
    <div className="sv-screen ip" onKeyDown={onKey}>
      <div className="ip__chrome">
        <span className="ip__lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="ip__navBtn" aria-hidden="true">
          <ArrowLeft />
        </span>
        <span className="ip__navBtn" aria-hidden="true">
          <ArrowRight />
        </span>
        <button
          type="button"
          className="ip__navBtn"
          aria-label="Reload sample page"
          onClick={reset}
        >
          <RotateCw aria-hidden="true" />
        </button>
        <span className="ip__url">
          <Lock aria-hidden="true" />
          anatomy.example.org/heart
        </span>
        <span className="ip__ext" aria-hidden="true">
          <LogoMark size={22} />
        </span>
      </div>

      <div className="ip__page" ref={page} tabIndex={-1} role="region" aria-label="Sample web page">
        <article className="ip__article" ref={article} onMouseUp={onPick} onKeyUp={onPick}>
          <p className="ip__site">Open Anatomy</p>
          <h3 className="ip__h">The heart</h3>
          <p>
            The heart is a muscular organ that pumps blood around the body. It has four chambers:
            two upper atria and two lower ventricles, divided by a wall called the septum.
          </p>
          <p>
            Valves keep blood moving in one direction.{' '}
            <span ref={target}>
              The sinoatrial node, found in the right atrium, produces the electrical signal that
              starts each heartbeat.
            </span>{' '}
            The signal then passes through the atrioventricular node to the ventricles, which
            contract a moment later.
          </p>
          <p>
            A normal resting heart rate for adults ranges from 60 to 100 beats per minute. Fitness,
            age and medicines all change it. Try selecting any sentence on this page.
          </p>
        </article>
        <div className="ip__host" ref={host} data-theme={theme} />
      </div>

      {mount &&
        createPortal(
          <>
            {range && pos && (
              <div
                className="tb"
                role="toolbar"
                aria-label="StudyVault"
                style={{ left: pos.x, top: pos.y }}
              >
                <span className="tb__logo" aria-hidden="true">
                  <LogoMark size={24} />
                </span>
                <div className="tb__dots" role="group" aria-label="Highlight colour">
                  {HL_COLOURS.map((c, i) => (
                    <button
                      key={c.id}
                      ref={i === 0 ? firstBtn : undefined}
                      type="button"
                      className={`tb__dot tb__dot--${c.id}`}
                      aria-label={`Save in ${c.name.toLowerCase()}`}
                      data-tip={c.name}
                      onClick={() => save(c.id)}
                    />
                  ))}
                </div>
                <span className="tb__sep" aria-hidden="true" />
                <button type="button" className="tb__save" onClick={() => save('yellow')}>
                  <Bookmark aria-hidden="true" />
                  Save
                </button>
                <button
                  type="button"
                  className="tb__icon"
                  aria-label="Save with note"
                  data-tip="Add note"
                  onClick={() => save('yellow', true)}
                >
                  <NotebookPen aria-hidden="true" />
                </button>
                <span className="tb__bankWrap">
                  <button
                    type="button"
                    className="tb__bank"
                    aria-expanded={menu}
                    aria-label={`Bank: ${bankInfo.name}`}
                    onClick={() => setMenu(!menu)}
                  >
                    <span aria-hidden="true">{bankInfo.emoji}</span>
                    <span className="tb__bankName" aria-hidden="true">
                      {bankInfo.name}
                    </span>
                    <ChevronDown aria-hidden="true" />
                  </button>
                  {menu && (
                    <ul className="tb__menu" aria-label="Save to bank">
                      {BANKS.map((b) => (
                        <li key={b.id}>
                          <button
                            type="button"
                            aria-pressed={b.id === bank}
                            onClick={() => {
                              setBank(b.id);
                              setMenu(false);
                            }}
                          >
                            <span aria-hidden="true">{b.emoji}</span>
                            {b.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </span>
              </div>
            )}
            <div className="toast-region" role="status">
              {toast && (
                <div className="toast">
                  <CircleCheck aria-hidden="true" className="toast__ok" />
                  <span className="toast__text">
                    <strong>Saved</strong>
                    <span>
                      {BANKS.find((b) => b.id === toast.bank)?.emoji}{' '}
                      {BANKS.find((b) => b.id === toast.bank)?.name}
                      {toast.note ? ' · note next' : ''}
                    </span>
                  </span>
                  <span className="toast__xp">
                    <Zap aria-hidden="true" />
                    +2 XP
                  </span>
                  {!canPaint && <span className="toast__warn">Not painted</span>}
                  <button type="button" className="toast__undo" onClick={undo}>
                    <Undo2 aria-hidden="true" />
                    Undo
                  </button>
                  <button
                    type="button"
                    className="tb__icon toast__x"
                    aria-label="Dismiss"
                    onClick={() => setToast(null)}
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>
          </>,
          mount,
        )}
    </div>
  );
}

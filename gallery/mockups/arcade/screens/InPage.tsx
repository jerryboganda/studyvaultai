// In-page toolbar on a sample article. The overlay renders inside an open shadow root with its own
// adopted stylesheet (CSP-safe, page CSS cannot reach in) and the system rounded font stack.
// Saved passages are painted with the CSS Custom Highlight API, so the article markup is untouched.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Bookmark, Check, ChevronDown, Lock, RotateCcw, StickyNote, X, Zap } from 'lucide-react';
import { BANKS, HL_COLORS, type HlColor, type Theme } from '../data';
import { VaultBuddy } from '../VaultBuddy';
import toolbarCss from '../toolbar.css?inline';

const DOTS = HL_COLORS.filter((c) => c.id !== 'orange');
const PAINTS: HlColor[] = ['gold', 'lime', 'pink', 'cyan', 'violet'];

interface Saved {
  color: HlColor;
  bank: string;
  note: boolean;
}

function Overlay({
  pos,
  theme,
  onSaved,
  saved,
  onUndo,
  onClose,
}: {
  pos: { x: number; y: number } | null;
  theme: Theme;
  saved: Saved | null;
  onSaved: (s: Saved) => void;
  onUndo: () => void;
  onClose: () => void;
}) {
  const [color, setColor] = useState<HlColor>('gold');
  const [bank, setBank] = useState('Biology');
  const [menu, setMenu] = useState(false);
  const bankBtn = useRef<HTMLButtonElement>(null);
  const undoBtn = useRef<HTMLButtonElement>(null);
  const b = BANKS.find((x) => x.name === bank);

  useEffect(() => {
    if (saved) undoBtn.current?.focus({ preventScroll: true });
  }, [saved]);

  const closeMenu = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && menu) {
      e.stopPropagation();
      setMenu(false);
      bankBtn.current?.focus();
    }
  };

  return (
    <div className="tb" data-theme={theme === 'system' ? undefined : theme}>
      {!saved && pos && (
        <div
          className="tb-bar"
          role="toolbar"
          aria-label="StudyVault"
          style={{ left: pos.x, top: pos.y }}
          onKeyDown={closeMenu}
        >
          <div className="tb-colors" role="group" aria-label="Colour">
            {DOTS.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`tb-dot tb-c-${c.id}`}
                aria-label={c.name}
                aria-pressed={color === c.id}
                onClick={() => setColor(c.id)}
              >
                {color === c.id && <Check aria-hidden size={14} strokeWidth={3.5} />}
              </button>
            ))}
          </div>
          <span className="tb-sep" aria-hidden />
          <button
            type="button"
            className="tb-save"
            onClick={() => onSaved({ color, bank, note: false })}
          >
            <Bookmark aria-hidden size={17} strokeWidth={2.8} />
            Save
          </button>
          <button
            type="button"
            className="tb-icon"
            aria-label="Save with note"
            title="Save with note"
            onClick={() => onSaved({ color, bank, note: true })}
          >
            <StickyNote aria-hidden size={19} strokeWidth={2.5} />
          </button>
          <span className="tb-sep" aria-hidden />
          <div className="tb-bankwrap">
            <button
              ref={bankBtn}
              type="button"
              className={`tb-bank tb-c-${b?.color === 'orange' ? 'gold' : (b?.color ?? 'gold')}`}
              aria-expanded={menu}
              aria-label={`Bank: ${bank}`}
              onClick={() => setMenu((m) => !m)}
            >
              <span className="tb-bank__dot" aria-hidden />
              {bank}
              <ChevronDown aria-hidden size={16} strokeWidth={2.8} />
            </button>
            {menu && (
              <ul className="tb-menu">
                {BANKS.map((x) => (
                  <li key={x.id}>
                    <button
                      type="button"
                      aria-pressed={bank === x.name}
                      onClick={() => {
                        setBank(x.name);
                        setMenu(false);
                        bankBtn.current?.focus();
                      }}
                    >
                      <x.icon aria-hidden size={16} strokeWidth={2.6} />
                      {x.name}
                      {bank === x.name && (
                        <Check className="tb-menu__check" aria-hidden size={16} strokeWidth={3} />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      {saved && (
        <div className="tb-toast" role="status">
          <span className="tb-toast__ok" aria-hidden>
            <Check size={16} strokeWidth={3.5} />
          </span>
          <span>{saved.note ? 'Saved · note in panel' : `Saved to ${saved.bank}`}</span>
          <span className="tb-xp">
            <Zap aria-hidden size={14} strokeWidth={3} />
            +2 XP
          </span>
          <button ref={undoBtn} type="button" className="tb-undo" onClick={onUndo}>
            Undo
          </button>
          <button type="button" className="tb-x" aria-label="Dismiss" onClick={onClose}>
            <X aria-hidden size={18} strokeWidth={2.8} />
          </button>
        </div>
      )}
    </div>
  );
}

export function InPage({ theme }: { theme: Theme }) {
  const page = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const sel = useRef<HTMLSpanElement>(null);
  const [shadow, setShadow] = useState<ShadowRoot | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [toast, setToast] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(toolbarCss);
    root.adoptedStyleSheets = [sheet];
    setShadow(root);
  }, []);

  useLayoutEffect(() => {
    const p = page.current?.getBoundingClientRect();
    const r = sel.current?.getClientRects()[0];
    if (p && r) setPos({ x: r.left - p.left + r.width / 2, y: r.top - p.top });
  }, []);

  // Paint: earlier saves plus the current selection, all through CSS.highlights.
  useEffect(() => {
    const root = page.current;
    if (!root || !('highlights' in CSS)) return;
    const byName = new Map<string, Range[]>();
    const add = (name: string, node: Node) => {
      const r = new Range();
      r.selectNodeContents(node);
      byName.set(name, [...(byName.get(name) ?? []), r]);
    };
    root
      .querySelectorAll<HTMLElement>('[data-paint]')
      .forEach((n) => add(`arc-hl-${n.dataset.paint}`, n));
    if (sel.current) add(saved ? `arc-hl-${saved.color}` : 'arc-sel', sel.current);
    const names = ['arc-sel', ...PAINTS.map((c) => `arc-hl-${c}`)];
    for (const n of names) {
      const ranges = byName.get(n);
      if (ranges) CSS.highlights.set(n, new Highlight(...ranges));
      else CSS.highlights.delete(n);
    }
    return () => names.forEach((n) => CSS.highlights.delete(n));
  }, [saved]);

  return (
    <div className="ip">
      <div className="ip-chrome">
        <span className="ip-url">
          <Lock aria-hidden size={14} strokeWidth={2.6} />
          example.org/cell-energy
        </span>
        <span className="ip-ext" title="StudyVault">
          <VaultBuddy pose="wave" size={22} />
        </span>
        <button
          type="button"
          className="sv-btn sv-btn--ghost sv-btn--sm ip-replay"
          onClick={() => {
            setSaved(null);
            setToast(false);
          }}
        >
          <RotateCcw aria-hidden size={16} strokeWidth={2.6} />
          <span>Replay</span>
        </button>
      </div>
      <div className="ip-page" ref={page}>
        <article className="ip-article" lang="en">
          <p className="ip-kicker">Example Science Notes</p>
          <h2>How cells make energy</h2>
          <p className="ip-byline">6 min read</p>
          <p>
            Every cell needs a steady supply of energy. Most of it comes from{' '}
            <span data-paint="lime">a molecule called ATP</span>, which works like a rechargeable
            battery for chemical jobs.
          </p>
          <p>
            <span ref={sel}>
              Mitochondria make most of the cell’s ATP through oxidative phosphorylation along the
              inner membrane.
            </span>{' '}
            The folds of that membrane, called cristae, give the process more room to work.
          </p>
          <p>
            When oxygen runs short, cells fall back on glycolysis alone. It is quick, but it yields{' '}
            <span data-paint="pink">far less ATP per glucose</span> molecule.
          </p>
          <p>
            Some poisons stop the chain outright. Cyanide, for example, blocks the last step, so
            oxygen sits unused.
          </p>
        </article>
        <div ref={host} className="ip-host" />
        {shadow &&
          createPortal(
            <Overlay
              pos={saved ? null : pos}
              theme={theme}
              saved={toast ? saved : null}
              onSaved={(s) => {
                setSaved(s);
                setToast(true);
              }}
              onUndo={() => {
                setSaved(null);
                setToast(false);
              }}
              onClose={() => setToast(false)}
            />,
            shadow,
          )}
      </div>
    </div>
  );
}

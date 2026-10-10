/** Test-only helpers (never imported by production code). */
import {
  BackgroundRpc,
  StudyVaultError,
  defaultSettings,
  type BankLite,
  type CaptureResult,
  type HighlightView,
  type Settings,
  type TabRpc,
} from '@shared';
import { buildTextStream, captureAnchor, type PaintEntry } from '@highlights';
import type { callBackground, Handlers } from '@runtime';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { CaptureHost, CaptureUi, SelectionInfo } from './contract';
import { startController, type Controller, type ControllerDeps } from './controller';
import type { PainterLike } from './rehydrator';

export function setBody(html: string): void {
  document.body.innerHTML = html;
}

function textNodes(root: Node = document.body): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/** A Range over the `occurrence`-th match of `needle` in the raw text nodes, like a user selection. */
export function rangeOver(needle: string, occurrence = 0): Range {
  const nodes = textNodes();
  let raw = '';
  const starts: number[] = [];
  for (const n of nodes) {
    starts.push(raw.length);
    raw += n.data;
  }
  let at = -1;
  for (let k = 0; k <= occurrence; k++) {
    at = raw.indexOf(needle, at + 1);
    if (at === -1) throw new Error(`needle not found: ${needle}`);
  }
  const end = at + needle.length;
  const range = document.createRange();
  for (let i = 0; i < nodes.length; i++) {
    const s = starts[i]!;
    const e = s + nodes[i]!.data.length;
    if (at >= s && at < e) range.setStart(nodes[i]!, at - s);
    if (end > s && end <= e) {
      range.setEnd(nodes[i]!, end - s);
      break;
    }
  }
  return range;
}

export function select(needle: string, occurrence = 0): Range {
  const range = rangeOver(needle, occurrence);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return range;
}

export function clearSelection(): void {
  document.getSelection()?.removeAllRanges();
}

let idCounter = 0;
export const newId = (prefix = 'hl'): string => `${prefix}-${String(++idCounter).padStart(8, '0')}`;

/** A stored highlight for `needle` as it would be captured on the CURRENT page. */
export function storedHighlight(
  needle: string,
  over: Partial<HighlightView> = {},
  occurrence = 0,
): HighlightView {
  const range = rangeOver(needle, occurrence);
  const anchored = captureAnchor(range, range.toString(), buildTextStream());
  if ('error' in anchored) throw new Error(`capture failed: ${anchored.error}`);
  return {
    id: newId(),
    sourceId: 'src-00000001',
    exactQuote: anchored.exactQuote,
    anchorSet: anchored.anchorSet,
    kind: 'essential',
    color: 'amber',
    priority: 3,
    userComment: '',
    headingContext: anchored.headingContext,
    bankIds: ['inbox-default'],
    capturedAt: '2026-10-11T10:00:00.000Z',
    resolveStatus: 'unchecked',
    resolveConfidence: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------

export class FakePainter implements PainterLike {
  supported = true;
  painted: PaintEntry[] = [];
  paintCalls = 0;
  clearCalls = 0;
  destroyed = false;
  active: string | null = null;
  hit: string | null = null;

  paint(entries: readonly PaintEntry[]): void {
    this.painted = [...entries];
    this.paintCalls += 1;
  }
  setActive(id: string | null): void {
    this.active = id;
  }
  hitTest(): string | null {
    return this.hit;
  }
  clear(): void {
    this.painted = [];
    this.clearCalls += 1;
  }
  destroy(): void {
    this.painted = [];
    this.destroyed = true;
  }
  get ids(): string[] {
    return this.painted.map((e) => e.id).sort();
  }
  get texts(): string[] {
    return this.painted.map((e) => e.range.toString());
  }
}

export interface Notice {
  text: string;
  tone?: 'info' | 'success' | 'error';
  action?: { label: string; run: () => void };
}

export class FakeUi implements CaptureUi {
  toolbar: SelectionInfo[] = [];
  hidden = 0;
  popovers: Array<{ view: HighlightView; anchor: DOMRect }> = [];
  toasts: Notice[] = [];
  applied: Settings[] = [];
  destroyed = false;

  showToolbar(selection: SelectionInfo): void {
    this.toolbar.push(selection);
  }
  hideToolbar(): void {
    this.hidden += 1;
  }
  showHighlightPopover(view: HighlightView, anchor: DOMRect): void {
    this.popovers.push({ view, anchor });
  }
  toast(notice: Notice): void {
    this.toasts.push(notice);
  }
  applySettings(settings: Settings): void {
    this.applied.push(settings);
  }
  destroy(): void {
    this.destroyed = true;
  }
}

export interface Call {
  type: string;
  payload: unknown;
}

/** In-memory service worker: validates payloads/responses with the real protocol schemas. */
export class FakeBackground {
  rows = new Map<string, HighlightView>();
  deleted = new Map<string, HighlightView>();
  calls: Call[] = [];
  failures: Array<{ type: string; error: Error; times: number }> = [];
  /** Requests of a gated type wait here before the worker handles them. */
  gates = new Map<string, Promise<void>>();
  epochListeners = new Set<() => void>();
  banks: BankLite[] = [{ id: 'inbox-default', name: 'Inbox', color: 'amber', isInbox: true }];

  callsOf(type: string): Call[] {
    return this.calls.filter((c) => c.type === type);
  }

  failNext(type: string, error: Error, times = 1): void {
    this.failures.push({ type, error, times });
  }

  /** Holds every request of `type` until the returned function is called. */
  hold(type: string): () => void {
    let release!: () => void;
    this.gates.set(
      type,
      new Promise<void>((resolve) => {
        release = () => {
          this.gates.delete(type);
          resolve();
        };
      }),
    );
    return release;
  }

  bump(): void {
    for (const l of [...this.epochListeners]) l();
  }

  readonly call = (async (type: string, payload: unknown) => {
    const def = (BackgroundRpc as unknown as Record<string, { payload: never; response: never }>)[
      type
    ]!;
    const parsed = (def.payload as { parse(v: unknown): unknown }).parse(payload);
    this.calls.push({ type, payload: parsed });
    await this.gates.get(type);
    const failure = this.failures.find((f) => f.type === type && f.times > 0);
    if (failure) {
      failure.times -= 1;
      throw failure.error;
    }
    const out = await this.handle(type, parsed as Record<string, never>);
    return (def.response as { parse(v: unknown): unknown }).parse(out);
  }) as unknown as typeof callBackground;

  private async handle(type: string, p: Record<string, unknown>): Promise<unknown> {
    switch (type) {
      case 'page.highlights':
        return { sourceId: 'src-00000001', highlights: [...this.rows.values()] };
      case 'capture.save': {
        const input = p as unknown as {
          exactQuote: string;
          anchorSet: HighlightView['anchorSet'];
          headingContext: string | null;
          kind: HighlightView['kind'];
          color: HighlightView['color'];
          userComment: string;
          priority: number;
          bankId: string | null;
        };
        const bank = this.banks.find((b) => b.id === input.bankId) ?? this.banks[0]!;
        const highlight: HighlightView = {
          id: newId(),
          sourceId: 'src-00000001',
          exactQuote: input.exactQuote,
          anchorSet: input.anchorSet,
          kind: input.kind,
          color: input.color,
          priority: input.priority as HighlightView['priority'],
          userComment: input.userComment,
          headingContext: input.headingContext,
          bankIds: [bank.id],
          capturedAt: '2026-10-11T10:00:00.000Z',
          resolveStatus: 'unchecked',
          resolveConfidence: null,
        };
        this.rows.set(highlight.id, highlight);
        this.bump();
        const result: CaptureResult = { status: 'created', highlight, bank, addedToBank: true };
        return result;
      }
      case 'highlight.reportResolution': {
        const items = p.items as Array<{
          id: string;
          status: HighlightView['resolveStatus'];
          confidence: number | null;
        }>;
        let changed = false;
        let updated = 0;
        for (const item of items) {
          const row = this.rows.get(item.id);
          if (!row) continue;
          updated += 1;
          if (row.resolveStatus !== item.status || row.resolveConfidence !== item.confidence) {
            changed = true;
          }
          this.rows.set(item.id, {
            ...row,
            resolveStatus: item.status,
            resolveConfidence: item.confidence,
          });
        }
        if (changed) this.bump(); // same rule as the real repo: only a real change notifies
        return { updated };
      }
      case 'highlight.delete': {
        const id = p.id as string;
        const row = this.rows.get(id);
        if (!row) throw new StudyVaultError('not_found', 'Highlight not found');
        this.rows.delete(id);
        this.deleted.set(id, row);
        this.bump();
        return { id };
      }
      case 'highlight.restore': {
        const id = p.id as string;
        const row = this.deleted.get(id);
        if (!row) throw new StudyVaultError('not_found', 'Highlight not found');
        this.deleted.delete(id);
        this.rows.set(id, row);
        this.bump();
        return row;
      }
      case 'highlight.update': {
        const id = p.id as string;
        const row = this.rows.get(id);
        if (!row) throw new StudyVaultError('not_found', 'Highlight not found');
        const next = { ...row, ...(p.patch as object) } as HighlightView;
        this.rows.set(id, next);
        this.bump();
        return next;
      }
      case 'banks.list':
        return { banks: this.banks, lastBankId: null };
      case 'bank.create': {
        const bank: BankLite = {
          id: newId('bank'),
          name: p.name as string,
          color: 'blue',
          isInbox: false,
        };
        this.banks.push(bank);
        return bank;
      }
      default:
        throw new StudyVaultError('not_found', `unhandled ${type}`);
    }
  }
}

export interface FakeCtx {
  isValid: boolean;
  invalidate(): void;
  onInvalidated(cb: () => void): () => void;
}

export function fakeCtx(): FakeCtx & ContentScriptContext {
  const listeners = new Set<() => void>();
  const ctx: FakeCtx = {
    isValid: true,
    invalidate() {
      if (!ctx.isValid) return;
      ctx.isValid = false;
      for (const l of [...listeners]) l();
    },
    onInvalidated(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return ctx as FakeCtx & ContentScriptContext;
}

export interface Harness {
  controller: Controller;
  background: FakeBackground;
  painter: FakePainter;
  ui: FakeUi;
  ctx: FakeCtx & ContentScriptContext;
  host: CaptureHost;
  handlers: Handlers<TabRpc>;
  settings: Settings;
  /** Push a settings change as `watchSettings` would. */
  setSettings(next: Partial<Settings>): void;
  readonly served: { active: boolean };
  readonly uiCreated: number;
  painters: FakePainter[];
}

export interface HarnessOptions {
  settings?: Partial<Settings>;
  background?: FakeBackground;
  /** Make the overlay factory fail. */
  uiFails?: boolean;
  /** The overlay factory waits for this before resolving. */
  uiGate?: Promise<void>;
  win?: Window & typeof globalThis;
}

/** Wires startController to in-memory fakes. Await `controller.ready` before asserting. */
export function startHarness(opts: HarnessOptions = {}): Harness {
  const background = opts.background ?? new FakeBackground();
  const ui = new FakeUi();
  const ctx = fakeCtx();
  const painters: FakePainter[] = [];
  let hostRef: CaptureHost | null = null;
  let handlers: Handlers<TabRpc> | null = null;
  const settingsListeners = new Set<(s: Settings) => void>();
  const served = { active: false };
  const state = { settings: { ...defaultSettings(), denyList: [], ...opts.settings } as Settings };

  const created = { count: 0 };
  const deps: ControllerDeps = {
    ctx,
    win: opts.win ?? window,
    version: '9.9.9',
    call: background.call,
    serve(h) {
      handlers = h;
      served.active = true;
      return () => {
        served.active = false;
      };
    },
    getSettings: async () => state.settings,
    watchSettings(cb) {
      settingsListeners.add(cb);
      return () => settingsListeners.delete(cb);
    },
    watchDataEpoch(cb) {
      background.epochListeners.add(cb);
      return () => background.epochListeners.delete(cb);
    },
    createUi: async (_ctx, host) => {
      created.count += 1;
      await opts.uiGate;
      if (opts.uiFails) throw new Error('ui boom');
      hostRef = host;
      return ui;
    },
    createPainter: () => {
      const p = new FakePainter();
      painters.push(p);
      return p;
    },
  };

  const controller = startController(deps);
  return {
    controller,
    background,
    ui,
    ctx,
    served,
    painters,
    get uiCreated() {
      return created.count;
    },
    get painter() {
      return painters[painters.length - 1]!;
    },
    get host() {
      return hostRef!;
    },
    get handlers() {
      return handlers!;
    },
    get settings() {
      return state.settings;
    },
    setSettings(next: Partial<Settings>) {
      state.settings = { ...state.settings, ...next };
      for (const l of [...settingsListeners]) l(state.settings);
    },
  };
}

/** Lets pending promise chains run without advancing fake timers. */
export async function flushPromises(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

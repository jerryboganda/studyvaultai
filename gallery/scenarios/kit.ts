import {
  DEFAULT_PALETTE,
  HIGHLIGHT_KINDS,
  type CaptureInput,
  type HighlightKind,
  type Settings,
} from '@shared';
import { updateSettings } from '@runtime';
import { saveCapture } from '@storage';
import { anchor } from '@storage/test-fixtures';
import type { SiteAccess } from '../../entrypoints/background/siteAccess';
import { browser, gallery } from '../shim/chrome';

/** Shared seeding helpers. Every date is relative to the real current time. */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** The real "now", fixed once per page so a whole scenario agrees on it. */
export const NOW = Date.now();
export const ago = (ms: number) => NOW - ms;

export interface ScenarioContext {
  params: URLSearchParams;
  site: SiteAccess;
}

export interface Scenario {
  id: string;
  title: string;
  /** Tab preset (see tabs.ts) used when the URL gives no `tab=`. */
  tab: string;
  seed(ctx: ScenarioContext): Promise<void>;
}

/** mulberry32: small seeded PRNG, so a scenario is the same on every load. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!,
    chance: (p: number) => next() < p,
    /** Weighted pick: [[value, weight], ...]. */
    weighted: <T>(entries: readonly (readonly [T, number])[]): T => {
      let roll = next() * entries.reduce((sum, [, w]) => sum + w, 0);
      for (const [value, w] of entries) if ((roll -= w) < 0) return value;
      return entries[entries.length - 1]![0];
    },
  };
}
export type Rng = ReturnType<typeof rng>;

// ---------------------------------------------------------------------------------------------
// Seed clock: storage stamps rows with `new Date()` and takes no time argument, so captures are
// backdated by freezing Date while they are written. Only used before the app mounts.
// ---------------------------------------------------------------------------------------------

const RealDate = Date;
let frozen: number | null = null;
const SeedDate = new Proxy(RealDate, {
  construct: (target, args, newTarget) =>
    Reflect.construct(target, args.length === 0 && frozen !== null ? [frozen] : args, newTarget),
  get: (target, prop, receiver) =>
    prop === 'now' ? () => frozen ?? target.now() : Reflect.get(target, prop, receiver),
});

/** Run `work` with the clock reading `at` (ms since epoch). */
export async function atTime<T>(at: number, work: () => Promise<T>): Promise<T> {
  globalThis.Date = SeedDate;
  frozen = at;
  try {
    return await work();
  } finally {
    frozen = null;
    globalThis.Date = RealDate;
  }
}

// ---------------------------------------------------------------------------------------------
// Captures
// ---------------------------------------------------------------------------------------------

export interface CaptureSpec {
  url: string;
  title: string;
  quote: string;
  at: number;
  heading?: string | null;
  kind?: HighlightKind;
  bankId?: string | null;
  comment?: string;
  priority?: 1 | 2 | 3 | 4 | 5;
}

/** Save a web highlight through the real capture path, at `spec.at`. */
export function capture(spec: CaptureSpec) {
  const kind = spec.kind ?? 'essential';
  const prefix = 'In clinical practice, ';
  const input: CaptureInput = {
    page: { url: spec.url, canonicalUrl: null, title: spec.title },
    exactQuote: spec.quote,
    anchorSet: anchor(spec.quote, 400 + (spec.quote.length % 900), prefix, ' This is discussed'),
    headingContext: spec.heading ?? null,
    kind,
    color: DEFAULT_PALETTE[kind],
    bankId: spec.bankId ?? null,
    userComment: spec.comment ?? '',
    priority: spec.priority ?? 3,
    captureMethod: 'toolbar',
  };
  return atTime(spec.at, () => saveCapture(input));
}

export const pickKind = (r: Rng): HighlightKind =>
  r.weighted<HighlightKind>([
    ['essential', 46],
    ['formula', 8],
    ['exception', 12],
    ['differential', 10],
    ['weak_area', 10],
    ['correction', 6],
    ['question', 8],
  ]);
export const pickPriority = (r: Rng) =>
  r.weighted<1 | 2 | 3 | 4 | 5>([
    [1, 6],
    [2, 18],
    [3, 46],
    [4, 20],
    [5, 10],
  ]);
export { HIGHLIGHT_KINDS };

// ---------------------------------------------------------------------------------------------
// Settings, onboarding and site access
// ---------------------------------------------------------------------------------------------

export function patchSettings(patch: Partial<Settings>) {
  return updateSettings((s) => ({ ...s, ...patch }));
}

export function completeOnboarding(presetId = 'blank') {
  return browser.storage.local.set({
    onboarding: {
      schemaVersion: 1,
      status: 'completed',
      step: 'done',
      preset: { id: presetId, excluded: [] },
      applied: null,
      updatedAt: new Date(ago(40 * DAY)).toISOString(),
    },
  });
}

/**
 * "Always enable on <site>" for each origin pattern, as the popup does it: Chrome grants the
 * optional host permission, the settings hint records it, and the real site sync registers the
 * persistent content script.
 */
export async function grantSites(ctx: ScenarioContext, origins: string[]) {
  for (const origin of origins) gallery.grantedOrigins.add(origin);
  await updateSettings((s) => ({
    ...s,
    persistentOrigins: [...new Set([...s.persistentOrigins, ...origins])],
  }));
  await ctx.site.sync();
}

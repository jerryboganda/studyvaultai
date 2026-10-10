import type { ResolveStatus } from '@shared';

export interface StatusPair {
  status: ResolveStatus;
  confidence: number | null;
}

export interface ReportItem extends StatusPair {
  id: string;
}

export interface ReportRow {
  id: string;
  /** What the service worker returned for this highlight. */
  server: StatusPair;
  /** What this tab just computed. */
  local: StatusPair;
}

const EPSILON = 0.005;

export function samePair(a: StatusPair, b: StatusPair): boolean {
  if (a.status !== b.status) return false;
  if (a.confidence === null || b.confidence === null) return a.confidence === b.confidence;
  return Math.abs(a.confidence - b.confidence) < EPSILON;
}

/** Protocol bounds: 0..1 or null. */
export function clampConfidence(c: number | null): number | null {
  if (c === null || Number.isNaN(c)) return null;
  return Math.min(1, Math.max(0, c));
}

/**
 * Decides which resolution outcomes are worth a `highlight.reportResolution` write.
 *
 * Every real change of a row bumps `dataEpoch`, every viewer re-fetches on that bump and compares
 * again, so a naive "report what I computed" loops. Two rules break the loop:
 *  1. only outcomes that differ from the row the worker returned are reported (an echo of our own
 *     report finds nothing left to say), and
 *  2. an outcome is compared against what THIS tab last sent for that id, not against the row. Two
 *     tabs that disagree about one page therefore settle after one write each instead of
 *     overwriting each other forever.
 * `markSent` is applied before the request is awaited so overlapping passes cannot duplicate it.
 */
export class ReportTracker {
  private readonly sent = new Map<string, StatusPair>();

  pending(rows: Iterable<ReportRow>): ReportItem[] {
    const out: ReportItem[] = [];
    for (const row of rows) {
      const known = this.sent.get(row.id) ?? row.server;
      if (!samePair(known, row.local)) {
        out.push({
          id: row.id,
          status: row.local.status,
          confidence: clampConfidence(row.local.confidence),
        });
      }
    }
    return out;
  }

  markSent(items: readonly ReportItem[]): void {
    for (const item of items)
      this.sent.set(item.id, { status: item.status, confidence: item.confidence });
  }

  /** The request failed: forget it so the next pass reports again. */
  unmark(items: readonly ReportItem[]): void {
    for (const item of items) this.sent.delete(item.id);
  }
}

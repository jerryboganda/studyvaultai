import { describe, expect, it } from 'vitest';
import { ReportTracker, clampConfidence, samePair, type ReportRow } from './reportTracker';

const row = (
  id: string,
  server: [ReportRow['server']['status'], number | null],
  local: [ReportRow['local']['status'], number | null],
): ReportRow => ({
  id,
  server: { status: server[0], confidence: server[1] },
  local: { status: local[0], confidence: local[1] },
});

describe('samePair', () => {
  it('compares status and confidence with a small tolerance', () => {
    const resolved = (confidence: number) => ({ status: 'resolved' as const, confidence });
    expect(samePair(resolved(1), resolved(0.999))).toBe(true);
    expect(samePair(resolved(1), resolved(0.9))).toBe(false);
    expect(samePair(resolved(1), { status: 'changed', confidence: 1 })).toBe(false);
    expect(
      samePair(
        { status: 'unchecked', confidence: null },
        { status: 'unchecked', confidence: null },
      ),
    ).toBe(true);
    expect(
      samePair({ status: 'unchecked', confidence: null }, { status: 'unchecked', confidence: 0 }),
    ).toBe(false);
  });

  it('clampConfidence keeps values inside the protocol range', () => {
    expect(clampConfidence(1.4)).toBe(1);
    expect(clampConfidence(-0.2)).toBe(0);
    expect(clampConfidence(Number.NaN)).toBeNull();
    expect(clampConfidence(null)).toBeNull();
  });
});

describe('ReportTracker', () => {
  it('reports only rows whose outcome differs from the stored row', () => {
    const t = new ReportTracker();
    const items = t.pending([
      row('a', ['unchecked', null], ['resolved', 1]),
      row('b', ['resolved', 1], ['resolved', 1]),
      row('c', ['resolved', 1], ['orphaned', 0]),
    ]);
    expect(items.map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('does not repeat an outcome that was already sent (in flight or acknowledged)', () => {
    const t = new ReportTracker();
    const rows = [row('a', ['unchecked', null], ['resolved', 1])];
    t.markSent(t.pending(rows));
    expect(t.pending(rows)).toEqual([]);
  });

  it('an echo of our own report finds nothing to say', () => {
    const t = new ReportTracker();
    t.markSent(t.pending([row('a', ['unchecked', null], ['resolved', 1])]));
    // The store now returns what we wrote.
    expect(t.pending([row('a', ['resolved', 1], ['resolved', 1])])).toEqual([]);
  });

  it('two viewers that disagree settle after one write each (no ping-pong)', () => {
    // Tab A computes resolved, tab B computes orphaned, for the same highlight.
    const a = new ReportTracker();
    const b = new ReportTracker();
    let stored: ReportRow['server'] = { status: 'unchecked', confidence: null };
    const writes: string[] = [];
    const A: ReportRow['local'] = { status: 'resolved', confidence: 1 };
    const B: ReportRow['local'] = { status: 'orphaned', confidence: 0 };

    for (let round = 0; round < 6; round++) {
      for (const [name, tracker, local] of [
        ['A', a, A],
        ['B', b, B],
      ] as const) {
        const items = tracker.pending([{ id: 'h', server: stored, local }]);
        if (items.length > 0) {
          tracker.markSent(items);
          stored = { status: items[0]!.status, confidence: items[0]!.confidence };
          writes.push(name);
        }
      }
    }
    expect(writes).toEqual(['A', 'B']);
  });

  it('a genuine change after a reported outcome is reported again', () => {
    const t = new ReportTracker();
    t.markSent(t.pending([row('a', ['unchecked', null], ['resolved', 1])]));
    expect(t.pending([row('a', ['resolved', 1], ['orphaned', 0])]).map((i) => i.status)).toEqual([
      'orphaned',
    ]);
  });

  it('after the page recovers, the earlier outcome is reported again', () => {
    const t = new ReportTracker();
    t.markSent(t.pending([row('a', ['resolved', 1], ['orphaned', 0])]));
    const back = t.pending([row('a', ['orphaned', 0], ['resolved', 1])]);
    expect(back.map((i) => i.status)).toEqual(['resolved']);
  });

  it('unmark makes a failed report eligible again', () => {
    const t = new ReportTracker();
    const rows = [row('a', ['unchecked', null], ['resolved', 1])];
    const items = t.pending(rows);
    t.markSent(items);
    t.unmark(items);
    expect(t.pending(rows)).toHaveLength(1);
  });
});

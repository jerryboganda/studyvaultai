import { filingMessage, type FilingOutcome } from '@shared';
import type { PdfFilingPort } from '@pdf';

/**
 * What the PDF reader tells the person about filing rules (docs/adr/017-filing-rules.md), as plain
 * toast descriptions. A rule reaches a reader highlight only when it names "PDF document" as a
 * source, so these notices are rare; they read the same as the page overlay's (`filingMessage`).
 */

export interface FilingToast {
  message: string;
  tone?: 'error';
  action?: { label: string; onClick(): void };
}

export interface Filed {
  id: string;
  filing: FilingOutcome;
}

const failure = (err: unknown, fallback: string): FilingToast => ({
  tone: 'error',
  message: err instanceof Error && err.message.trim() !== '' ? err.message : fallback,
});

/** One toast per distinct result: a selection over two pages makes two highlights, one rule. */
export function filingToasts(
  items: readonly Filed[],
  port: FilingPort,
  push: (toast: FilingToast) => void,
  refresh: () => Promise<void> | void,
): FilingToast[] {
  const groups = new Map<string, Filed[]>();
  for (const item of items) {
    const key = filingMessage(item.filing);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const out: FilingToast[] = [];
  for (const [message, group] of groups) {
    const first = group[0]!.filing;
    const ids = group.map((g) => g.id);
    const text = ids.length > 1 ? `${message} (${ids.length} highlights)` : message;
    if (first.status === 'unavailable') {
      out.push({ message: text });
    } else if (first.status === 'filed') {
      out.push({
        message: text,
        action: { label: 'Undo', onClick: () => undo(ids, port, push, refresh) },
      });
    } else {
      out.push({
        message: text,
        action: {
          label: 'File',
          onClick: () => {
            void Promise.all(ids.map((id) => port.accept(id))).then(
              async (done) => {
                await refresh();
                const filed = done.flatMap((outcome, i) =>
                  outcome.status === 'filed' ? [{ id: ids[i]!, filing: outcome }] : [],
                );
                const problems = done.filter((d) => d.status === 'unavailable');
                if (filed.length > 0) {
                  for (const t of filingToasts(filed, port, push, refresh)) push(t);
                }
                for (const p of problems) push({ message: filingMessage(p) });
              },
              (err: unknown) => push(failure(err, 'Could not file the highlight.')),
            );
          },
        },
      });
    }
  }
  return out;
}

function undo(
  ids: readonly string[],
  port: FilingPort,
  push: (toast: FilingToast) => void,
  refresh: () => Promise<void> | void,
): void {
  void Promise.all(ids.map((id) => port.undo(id))).then(
    async (done) => {
      await refresh();
      const bad = done.find((d) => !d.restored);
      push({
        message: bad
          ? (bad.reason ?? 'Nothing was undone.')
          : 'Filing undone. The highlight is back where it was.',
      });
    },
    (err: unknown) => push(failure(err, 'Could not undo the filing.')),
  );
}

export type FilingPort = PdfFilingPort;

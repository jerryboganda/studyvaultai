import { withDb } from './db';
import type { StorageUsage } from './types';

/** Row counts of every table, the size of cached PDFs and the browser's quota estimate. */
export async function getStorageUsage(): Promise<StorageUsage> {
  const { rows, cachedPdfBytes, cachedPdfCount } = await withDb((db) =>
    db.transaction('r', db.tables, async () => {
      const rows: Record<string, number> = {};
      for (const table of db.tables) rows[table.name] = await table.count();
      let cachedPdfBytes = 0;
      await db.attachments.each((a) => {
        cachedPdfBytes += typeof a.byteLength === 'number' ? a.byteLength : 0;
      });
      return { rows, cachedPdfBytes, cachedPdfCount: rows.attachments ?? 0 };
    }),
  );
  let estimate: StorageUsage['estimate'] = null;
  try {
    const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
    if (storage?.estimate) {
      const e = await storage.estimate();
      estimate = { usage: e.usage ?? null, quota: e.quota ?? null };
    }
  } catch {
    estimate = null; // an estimate is a convenience, not a requirement
  }
  return {
    rows,
    totalRows: Object.values(rows).reduce((a, b) => a + b, 0),
    cachedPdfBytes,
    cachedPdfCount,
    estimate,
  };
}

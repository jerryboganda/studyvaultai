import { strToU8, zipSync } from 'fflate';
import type { ExportFile } from './markdown';

/** Pack text files into a ZIP (deflate). `mtime` is injected for reproducible bytes. */
export function zipFiles(files: readonly ExportFile[], mtime: Date = new Date()): Uint8Array {
  const entries: Record<string, [Uint8Array, { mtime: Date }]> = {};
  for (const f of files) entries[f.path] = [strToU8(f.content), { mtime }];
  return zipSync(entries);
}

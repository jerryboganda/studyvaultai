/**
 * The pdf.js assets the reader ships (all extension-origin, no CDN; MV3 forbids remote code).
 * Vite-only module: it uses `?url` imports and `import.meta.glob`, so only the reader entrypoint
 * imports it. Sizes (pdfjs-dist 6.4.299): worker 1.3 MB, cMaps 1.5 MB (169 files, fetched on
 * demand for CJK/legacy encodings), standard fonts 0.8 MB (14 files, on demand), wasm decoders
 * 0.35 MB (JBIG2 + JPEG2000, only used when the CSP allows 'wasm-unsafe-eval').
 */
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url&no-inline';
import type { BinaryDataFactoryCtor, PdfRuntime } from './engine';

type UrlMap = Record<string, string>;

const byName = (glob: UrlMap): UrlMap =>
  Object.fromEntries(
    Object.entries(glob).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]),
  );

const files: Record<string, UrlMap> = {
  cMapUrl: byName(
    import.meta.glob('../../../node_modules/pdfjs-dist/cmaps/*.bcmap', {
      query: '?url&no-inline',
      import: 'default',
      eager: true,
    }) as UrlMap,
  ),
  standardFontDataUrl: byName(
    import.meta.glob('../../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}', {
      query: '?url&no-inline',
      import: 'default',
      eager: true,
    }) as UrlMap,
  ),
  wasmUrl: byName(
    import.meta.glob('../../../node_modules/pdfjs-dist/wasm/{jbig2,openjpeg}.wasm', {
      query: '?url&no-inline',
      import: 'default',
      eager: true,
    }) as UrlMap,
  ),
};

/** Serves cMaps, standard fonts and wasm to the pdf.js worker from the bundled, hashed assets. */
class BundledBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const url = files[kind]?.[filename];
    if (!url) throw new Error(`StudyVault does not bundle ${kind} file ${filename}.`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load bundled file ${filename} (HTTP ${res.status}).`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

export const bundledRuntime: PdfRuntime = {
  workerSrc,
  BinaryDataFactory: BundledBinaryDataFactory as unknown as BinaryDataFactoryCtor,
};

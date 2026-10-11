import { build } from 'vite';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const root = process.cwd();
const BACKSLASH = String.fromCharCode(92);
const norm = (p) => p.split(BACKSLASH).join('/');
const alias = {
  '@shared': 'packages/shared/src',
  '@storage': 'packages/storage/src',
  '@ui': 'packages/ui/src',
  '@search': 'packages/search/src',
  '@study': 'packages/study/src',
  '@ai': 'packages/ai/src',
};
async function measure(entries) {
  const abs = entries.map((e) => norm(path.resolve(root, e)));
  const out = await build({
    configFile: false,
    logLevel: 'silent',
    root,
    resolve: {
      alias: Object.fromEntries(
        Object.entries(alias).map(([k, v]) => [k, path.resolve(root, v)]),
      ),
    },
    oxc: { jsx: { runtime: 'automatic' } },
    build: {
      write: false,
      minify: true,
      lib: { entry: abs, formats: ['es'] },
      rollupOptions: {
        external: (id) => !abs.includes(norm(id)),
      },
    },
  });
  const chunks = (Array.isArray(out) ? out : [out]).flatMap((o) => o.output);
  return chunks
    .filter((c) => c.type === 'chunk')
    .map((c) => ({
      file: c.fileName,
      bytes: Buffer.byteLength(c.code),
      gzip: gzipSync(c.code).length,
    }));
}
const groups = {
  links: ['packages/ui/src/vault/Links.tsx', 'packages/ui/src/vault/linkLabels.ts'],
  storageGraph: ['packages/storage/src/graph.ts'],
  linkContradiction: ['packages/ui/src/ai/LinkContradiction.tsx'],
  sharedGraph: ['packages/shared/src/graph.ts'],
  graphView: ['entrypoints/dashboard/GraphView.tsx'],
};
for (const [name, entries] of Object.entries(groups)) {
  try {
    console.log(name, JSON.stringify(await measure(entries)));
  } catch (e) {
    console.log(name, 'ERR', String(e.message).slice(0, 400));
  }
}

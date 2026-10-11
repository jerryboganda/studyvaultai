// Copies the offline OCR engine files from node_modules into public/ocr/ so WXT ships them inside the
// extension (packages/ocr never reaches a CDN). The folder is GENERATED and git-ignored: ~6 MB of
// wasm + traineddata must not live in the repository.
//
//   node scripts/copy-ocr-assets.mjs                  copy (idempotent) and verify sha-256
//   node scripts/copy-ocr-assets.mjs --check          verify only, write nothing, exit 1 on drift
//   node scripts/copy-ocr-assets.mjs --write-manifest re-record hashes after a deliberate dependency bump
//
// Source of truth for the file list and hashes: packages/ocr/assets.manifest.json (committed).
// WXT runs this automatically before every build through modules/ocr-assets.ts.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST_REL = join('packages', 'ocr', 'assets.manifest.json');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Directory of an installed package. `via` resolves transitive deps (pnpm does not hoist them). */
function packageDir(root, name, via) {
  const from = via ? join(packageDir(root, via), 'package.json') : join(root, 'package.json');
  const resolved = createRequire(from).resolve(`${name}/package.json`);
  return dirname(resolved);
}

async function readInstalledVersion(dir) {
  return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).version;
}

async function readIfExists(path) {
  try {
    return await readFile(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/** Atomic replace so a concurrent build never copies a half-written file. */
async function writeAtomic(dest, data) {
  const tmp = `${dest}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  try {
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true });
    // Windows can refuse to rename over a file another build is reading; fine if it already matches.
    const now = await readIfExists(dest);
    if (!now || sha256(now) !== sha256(data)) throw err;
  }
}

/**
 * @param {{ root?: string, outDir?: string, check?: boolean, writeManifest?: boolean,
 *           log?: (line: string) => void }} [options]
 * @returns {Promise<{ files: { name: string, bytes: number, sha256: string, status: string }[], totalBytes: number }>}
 */
export async function copyOcrAssets(options = {}) {
  const root = options.root ?? repoRoot;
  const outDir = options.outDir ?? join(root, 'public', 'ocr');
  const log = options.log ?? console.log;
  const manifestPath = join(root, MANIFEST_REL);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schema !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`${MANIFEST_REL}: unsupported or empty manifest`);
  }

  const results = [];
  const problems = [];
  const sources = new Map();
  for (const entry of manifest.files) {
    const pkgDir = packageDir(root, entry.package, entry.via);
    const source = join(pkgDir, ...entry.path.split('/'));
    const data = await readIfExists(source);
    if (!data) {
      problems.push(
        `${entry.name}: source missing: ${entry.package}/${entry.path} (run pnpm install)`,
      );
      continue;
    }
    const actual = sha256(data);
    if (options.writeManifest) {
      entry.version = await readInstalledVersion(pkgDir);
      entry.bytes = data.length;
      entry.sha256 = actual;
    } else if (actual !== entry.sha256) {
      const version = await readInstalledVersion(pkgDir);
      problems.push(
        `${entry.name}: sha-256 mismatch for ${entry.package}@${version}/${entry.path}\n` +
          `    recorded ${entry.sha256}\n    actual   ${actual}\n` +
          `    A dependency changed. Review the update, then run: node scripts/copy-ocr-assets.mjs --write-manifest`,
      );
      continue;
    }
    sources.set(entry.name, data);
  }
  if (problems.length > 0) {
    throw new Error(`OCR assets cannot be prepared:\n  - ${problems.join('\n  - ')}`);
  }
  if (options.writeManifest) {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    log(`ocr-assets: re-recorded ${manifest.files.length} hashes in ${MANIFEST_REL}`);
  }

  if (!options.check) await mkdir(outDir, { recursive: true });
  const wanted = new Set(manifest.files.map((f) => f.name));
  for (const entry of manifest.files) {
    const data = sources.get(entry.name);
    const dest = join(outDir, entry.name);
    const current = await readIfExists(dest);
    let status = 'unchanged';
    if (!current || sha256(current) !== sha256(data)) {
      if (options.check) {
        problems.push(
          `${entry.name}: ${current ? 'differs from the manifest' : 'missing'} in ${outDir}`,
        );
        status = current ? 'DIFFERS' : 'MISSING';
      } else {
        await writeAtomic(dest, data);
        status = current ? 'updated' : 'copied';
      }
    }
    results.push({ name: entry.name, bytes: data.length, sha256: sha256(data), status });
  }
  // "Exactly the needed files": drop leftovers from a previous variant choice.
  if (!options.check) {
    for (const name of await readdir(outDir)) {
      if (!wanted.has(name)) {
        await rm(join(outDir, name), { recursive: true, force: true });
        results.push({ name, bytes: 0, sha256: '', status: 'removed (not in manifest)' });
      }
    }
  }
  if (problems.length > 0)
    throw new Error(`OCR assets out of date:\n  - ${problems.join('\n  - ')}`);

  const totalBytes = results.reduce((n, r) => n + r.bytes, 0);
  const changed = results.filter((r) => r.status !== 'unchanged').length;
  log(
    `ocr-assets: ${results.length} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MiB in ` +
      `${outDir} (${changed === 0 ? 'up to date' : `${changed} changed`})`,
  );
  for (const r of results.filter((x) => x.status !== 'unchanged')) {
    log(`  ${r.status.padEnd(10)} ${r.name} ${r.bytes} B ${r.sha256.slice(0, 12)}`);
  }
  return { files: results, totalBytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = new Set(process.argv.slice(2));
  copyOcrAssets({ check: args.has('--check'), writeManifest: args.has('--write-manifest') }).catch(
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}

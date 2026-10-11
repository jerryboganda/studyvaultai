// CycloneDX 1.5 SBOM generated from pnpm-lock.yaml (no remote code, no extra dependency).
//
//   node scripts/sbom.mjs --out sbom.cdx.json [--all] [--artifact studyvault.zip] [--timestamp ISO]
//
// Default scope is the production closure: the only packages that can end up in the extension.
// --all adds the development tooling. Component hashes are the lockfile's registry integrity
// (SHA-512 of the published tarball), so the SBOM can be checked against what pnpm installed.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { argv, exit } from 'node:process';
import { collectPackages, splitSpec } from './lib/lockfile.mjs';

const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const out = flag('--out');
if (!out) {
  console.error(
    'usage: node scripts/sbom.mjs --out <file.json> [--all] [--artifact <zip>] [--timestamp <iso>]',
  );
  exit(2);
}

const purl = (name, version) => `pkg:npm/${name.replace(/^@/, '%40')}@${version}`;
const hex = (integrity) => {
  const m = /^sha512-(.+)$/.exec(integrity);
  return m ? Buffer.from(m[1], 'base64').toString('hex') : null;
};
const licenses = (license) => {
  if (!license) return undefined;
  const compound = /[\s()]/.test(license);
  return [compound ? { expression: license } : { license: { id: license } }];
};

const { lock, packages } = collectPackages('.');
const wanted = argv.includes('--all') ? packages : packages.filter((p) => p.scope === 'prod');
const keys = new Set(wanted.map((p) => p.key));
const own = JSON.parse(readFileSync('package.json', 'utf8'));
const lockText = readFileSync('pnpm-lock.yaml');

const components = wanted.map((p) => {
  const sha = hex(p.integrity);
  return {
    type: 'library',
    'bom-ref': purl(p.name, p.version),
    name: p.name,
    version: p.version,
    purl: purl(p.name, p.version),
    scope: p.scope === 'prod' ? 'required' : 'excluded',
    ...(sha ? { hashes: [{ alg: 'SHA-512', content: sha }] } : {}),
    ...(licenses(p.license) ? { licenses: licenses(p.license) } : {}),
    ...(p.installed ? {} : { properties: [{ name: 'studyvault:installed', value: 'false' }] }),
  };
});

// Dependency graph between the included packages (snapshots carry peer-resolved ids).
const edges = new Map();
for (const [id, deps] of lock.snapshots) {
  const from = splitSpec(id)?.key;
  if (!from || !keys.has(from)) continue;
  const set = edges.get(from) ?? new Set();
  for (const dep of deps) {
    const to = splitSpec(dep)?.key;
    if (to && keys.has(to) && to !== from) set.add(to);
  }
  edges.set(from, set);
}
const ref = (key) => {
  const s = splitSpec(key);
  return purl(s.name, s.version);
};

const artifact = flag('--artifact');
const appRef = `pkg:generic/${own.name}@${own.version}`;
const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  // Derived from the lockfile so regenerating the same tree gives the same serial number.
  serialNumber: `urn:uuid:${createHash('sha256')
    .update(lockText)
    .digest('hex')
    .slice(0, 32)
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')}`,
  version: 1,
  metadata: {
    timestamp: flag('--timestamp') ?? new Date().toISOString(),
    tools: { components: [{ type: 'application', name: 'studyvault-sbom-script', version: '1' }] },
    component: {
      type: 'application',
      'bom-ref': appRef,
      name: own.name,
      version: own.version,
      description: own.description,
      ...(artifact
        ? {
            hashes: [
              {
                alg: 'SHA-256',
                content: createHash('sha256').update(readFileSync(artifact)).digest('hex'),
              },
            ],
          }
        : {}),
    },
  },
  components,
  dependencies: [
    {
      ref: appRef,
      dependsOn: lock.importerDeps
        .filter((d) => !d.dev || argv.includes('--all'))
        .map((d) => splitSpec(d.id)?.key)
        .filter((k) => k && keys.has(k))
        .map(ref),
    },
    ...[...edges].map(([key, set]) => ({ ref: ref(key), dependsOn: [...set].sort().map(ref) })),
  ],
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(bom, null, 2)}\n`);
console.log(
  `SBOM: ${components.length} components, ${bom.dependencies.length} dependency entries -> ${out}`,
);

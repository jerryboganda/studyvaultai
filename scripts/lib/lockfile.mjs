// Shared by license-report.mjs and sbom.mjs: reads pnpm-lock.yaml and the installed package.json
// files. No YAML dependency: the lockfile is regular and indentation based and only a few sections
// are needed. Anything it does not understand yields fewer entries, never invented ones.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** "name@1.2.3(peer@1)" -> { name, version, key: "name@1.2.3" }; null when there is no version. */
export function splitSpec(spec) {
  const base = spec.split('(')[0];
  const at = base.lastIndexOf('@');
  if (at <= 0) return null;
  const name = base.slice(0, at);
  const version = base.slice(at + 1);
  return { name, version, key: `${name}@${version}` };
}

/** One lockfile line (already trimmed) -> [key, value]; keys may be quoted. */
function splitEntry(text) {
  if (text[0] === "'" || text[0] === '"') {
    const end = text.indexOf(text[0], 1);
    return [text.slice(1, end), text.slice(end + 1).replace(/^:\s*/, '')];
  }
  const m = /^(\S+?):(?:\s+(.*))?$/.exec(text);
  return m ? [m[1], (m[2] ?? '').replace(/^'(.*)'$/, '$1')] : [text, ''];
}

/** The snapshot id a dependency edge points at (an alias carries its real "name@version"). */
function edge(name, version) {
  const bare = version.split('(')[0];
  if (!bare || /^(link|file|workspace):/.test(bare)) return null;
  return bare.includes('@') ? version : `${name}@${version}`;
}

/**
 * Reads the project document of pnpm-lock.yaml (the last YAML document; pnpm 11+ prepends one for
 * its own tooling).
 */
export function parseLockfile(text) {
  const docs = text.split(/^---\s*$/m).filter((d) => d.trim());
  const lines = (docs.at(-1) ?? '').split(/\r?\n/);
  const importerDeps = [];
  const packages = new Map();
  const snapshots = new Map();
  let section = '';
  let current = '';
  let group = '';
  let depName = '';
  let mine = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const [key, value] = splitEntry(line);
    if (indent === 0) {
      section = key;
      current = group = depName = '';
    } else if (section === 'importers') {
      if (indent === 2) mine = key === '.';
      else if (!mine) continue;
      else if (indent === 4) group = key;
      else if (indent === 6) depName = key;
      else if (indent === 8 && key === 'version' && /ependencies$/.test(group)) {
        const id = edge(depName, value);
        if (id) importerDeps.push({ id, dev: group === 'devDependencies' });
      }
    } else if (section === 'packages') {
      if (indent === 2) {
        current = key;
        const s = splitSpec(key);
        if (s) packages.set(s.key, { name: s.name, version: s.version, integrity: '' });
      } else if (indent === 4 && key === 'resolution') {
        const s = splitSpec(current);
        const m = /integrity:\s*([^,}\s]+)/.exec(value);
        if (s && m) packages.get(s.key).integrity = m[1];
      }
    } else if (section === 'snapshots') {
      if (indent === 2) {
        current = key;
        group = '';
        snapshots.set(key, []);
      } else if (indent === 4) group = key;
      else if (indent === 6 && /^(optionalD|d)ependencies$/.test(group)) {
        const id = edge(key, value);
        if (id) snapshots.get(current)?.push(id);
      }
    }
  }
  return { importerDeps, packages, snapshots };
}

/** Snapshot ids reachable from the project's production (and optional) dependencies. */
export function productionClosure(lock) {
  const seen = new Set();
  const stack = lock.importerDeps.filter((d) => !d.dev).map((d) => d.id);
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(lock.snapshots.get(id) ?? []));
  }
  return seen;
}

/**
 * Finds where `name@version` is installed in pnpm's virtual store (node_modules/.pnpm). A directory
 * name starts with the escaped "name@version"; pnpm cuts long ones short and appends a hash, so a
 * candidate may also be a PREFIX of it. Candidates are confirmed by the package.json inside.
 */
function installedFinder(root) {
  const store = join(root, 'node_modules', '.pnpm');
  const entries = existsSync(store) ? readdirSync(store) : [];
  return (name, version) => {
    const want = `${name.replace('/', '+')}@${version}`;
    for (const entry of entries) {
      const cut = entry.lastIndexOf('_');
      const plausible = entry.startsWith(want) || (cut > 0 && want.startsWith(entry.slice(0, cut)));
      if (!plausible) continue;
      const dir = join(store, entry, 'node_modules', name);
      if (readMeta(dir)?.version === version) return dir;
    }
    return null;
  };
}

function readMeta(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** License expression of a parsed package.json (string, {type} or the legacy array), or null. */
export function licenseOf(meta) {
  const l = meta?.license ?? meta?.licenses;
  if (typeof l === 'string') return l.trim() || null;
  if (Array.isArray(l)) {
    const parts = l.map((x) => (typeof x === 'string' ? x : x?.type)).filter(Boolean);
    return parts.length > 0 ? parts.join(' OR ') : null;
  }
  return l?.type ? String(l.type) : null;
}

/**
 * Every package of the lockfile with its scope ('prod' = reachable from production dependencies),
 * integrity and, when installed, its declared license. Platform-specific optional packages that
 * were not installed on this machine have `installed: false`.
 */
export function collectPackages(root = '.') {
  const lock = parseLockfile(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
  const prod = new Set([...productionClosure(lock)].map((id) => splitSpec(id)?.key));
  const find = installedFinder(root);
  const packages = [...lock.packages.entries()].map(([key, p]) => {
    const dir = find(p.name, p.version);
    const meta = dir ? readMeta(dir) : null;
    return {
      ...p,
      key,
      scope: prod.has(key) ? 'prod' : 'dev',
      installed: meta !== null,
      license: licenseOf(meta),
      homepage: typeof meta?.homepage === 'string' ? meta.homepage : null,
    };
  });
  return { lock, packages: packages.sort((a, b) => a.key.localeCompare(b.key)) };
}

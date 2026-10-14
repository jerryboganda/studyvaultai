// Dependency licence audit (RELEASE.md, SECURITY_PRIVACY.md "audit dependencies and licenses").
//
//   node scripts/license-report.mjs [--json out.json] [--markdown out.md] [--self-test]
//
// Reads pnpm-lock.yaml for the package list and each installed package.json for its declared
// licence. Fails (exit 1) when a package is under a licence that is not on the allow-list, is a
// GPL-family / source-available licence, or declares none, unless EXCEPTIONS names it with a reason.
// A package that is not installed on this machine (platform-specific optional binaries) cannot be
// inspected: it is counted and listed, never silently treated as allowed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { argv, exit } from 'node:process';
import { collectPackages } from './lib/lockfile.mjs';

/** OSI-approved licences (SPDX ids) that may be bundled into the extension. */
const OSI_ALLOWED = [
  '0BSD',
  'Apache-2.0',
  'Artistic-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MIT',
  'MIT-0',
  'MPL-2.0', // file-level copyleft: fine while the files are used unmodified
  'OFL-1.1', // fonts (Nunito): may be bundled with software if the licence text ships with them
  'PSF-2.0',
  'Python-2.0',
  'Unlicense',
  'Zlib',
];

/** Permissive licences that are not on the OSI list; each needs its reason stated here. */
const EXTRA_ALLOWED = {
  'BlueOak-1.0.0': 'permissive, no copyleft; not OSI-approved but equivalent to ISC/MIT in effect',
  'CC0-1.0': 'public-domain dedication, no conditions; not OSI-approved',
};

/** Copyleft or source-available families: never allowed without an explicit exception. */
const RESTRICTED = /^(A?GPL|LGPL|SSPL|BUSL|EUPL|OSL|CPAL|CDDL|EPL|CC-BY-N|Elastic|Commons-Clause)/i;

/**
 * Packages allowed despite their licence, keyed by "name" or "name@version", each with a reason.
 * Keep this list short and review it at every dependency update.
 */
const EXCEPTIONS = {
  'caniuse-lite':
    'CC-BY-4.0 browser-support data read by build tooling (browserslist); development scope only, never bundled into the extension',
};

const allowed = new Map(
  [...OSI_ALLOWED, ...Object.keys(EXTRA_ALLOWED)].map((id) => [id.toLowerCase(), id]),
);

/** SPDX expression -> boolean tree. Understands OR, AND, WITH and parentheses. */
function parseExpression(text) {
  const tokens = text.replace(/[()]/g, ' $& ').split(/\s+/).filter(Boolean);
  let pos = 0;
  const atom = () => {
    const t = tokens[pos++];
    if (t === '(') {
      const inner = or();
      if (tokens[pos++] !== ')') throw new Error('unbalanced parentheses');
      return inner;
    }
    if (t === undefined || /^(AND|OR|WITH|\))$/i.test(t)) throw new Error(`unexpected "${t}"`);
    if (tokens[pos]?.toUpperCase() === 'WITH') pos += 2; // "Apache-2.0 WITH LLVM-exception": the id decides
    return { id: t.replace(/\+$/, '') };
  };
  const and = () => {
    const parts = [atom()];
    while (tokens[pos]?.toUpperCase() === 'AND') {
      pos++;
      parts.push(atom());
    }
    return parts.length === 1 ? parts[0] : { all: parts };
  };
  const or = () => {
    const parts = [and()];
    while (tokens[pos]?.toUpperCase() === 'OR') {
      pos++;
      parts.push(and());
    }
    return parts.length === 1 ? parts[0] : { any: parts };
  };
  const tree = or();
  if (pos !== tokens.length) throw new Error(`unexpected "${tokens[pos]}"`);
  return tree;
}

/** { ok, restricted } for an SPDX expression: an OR is satisfied by any alternative, an AND by all. */
function evaluate(expression) {
  let tree;
  try {
    tree = parseExpression(expression);
  } catch {
    return { ok: false, restricted: false };
  }
  const walk = (node) => {
    if (node.id !== undefined) {
      return { ok: allowed.has(node.id.toLowerCase()), restricted: RESTRICTED.test(node.id) };
    }
    const results = (node.any ?? node.all).map(walk);
    return node.any
      ? { ok: results.some((r) => r.ok), restricted: results.every((r) => r.restricted) }
      : { ok: results.every((r) => r.ok), restricted: results.some((r) => r.restricted) };
  };
  return walk(tree);
}

function judge(pkg) {
  const reason = EXCEPTIONS[pkg.key] ?? EXCEPTIONS[pkg.name];
  if (reason) return { status: 'exception', note: reason };
  if (!pkg.installed) return { status: 'not-installed', note: 'not installed on this platform' };
  if (!pkg.license) return { status: 'violation', note: 'declares no licence' };
  const result = evaluate(pkg.license);
  if (result.ok) return { status: 'ok', note: '' };
  return {
    status: 'violation',
    note: result.restricted
      ? 'copyleft or source-available licence'
      : 'licence not on the allow-list',
  };
}

function selfTest() {
  const cases = [
    ['MIT', true],
    ['(MIT OR Apache-2.0)', true],
    ['(MPL-2.0 OR Apache-2.0)', true],
    ['MIT AND GPL-3.0-only', false],
    ['GPL-3.0-or-later', false],
    ['(MIT OR GPL-2.0+)', true],
    ['Apache-2.0 WITH LLVM-exception', true],
    ['mit', true],
    ['SEE LICENSE IN LICENSE.txt', false],
    ['(MIT', false],
    ['', false],
  ];
  for (const [expr, ok] of cases) {
    const got = evaluate(expr).ok;
    if (got !== ok) throw new Error(`self-test: "${expr}" expected ${ok}, got ${got}`);
  }
  if (!evaluate('AGPL-3.0-only').restricted) throw new Error('self-test: AGPL not restricted');
  console.log(`license-report self-test ok (${cases.length} expressions)`);
}

function main() {
  const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  if (argv.includes('--self-test')) return selfTest();

  const { packages } = collectPackages('.');
  const rows = packages.map((p) => ({ ...p, ...judge(p) }));
  const count = (pred) => rows.filter(pred).length;
  const violations = rows.filter((r) => r.status === 'violation');
  const byLicense = new Map();
  for (const r of rows.filter((x) => x.installed)) {
    byLicense.set(r.license ?? '(none)', (byLicense.get(r.license ?? '(none)') ?? 0) + 1);
  }

  console.log(
    `${rows.length} packages in pnpm-lock.yaml: ${count((r) => r.scope === 'prod')} production, ` +
      `${count((r) => r.scope === 'dev')} development; ${count((r) => !r.installed)} not installed here.`,
  );
  for (const [license, n] of [...byLicense].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${license}`);
  }
  const exceptions = rows.filter((r) => r.status === 'exception');
  for (const r of exceptions) console.log(`EXCEPTION ${r.key} (${r.license}): ${r.note}`);
  const unchecked = rows.filter((r) => r.status === 'not-installed' && r.scope === 'prod');
  if (unchecked.length > 0) {
    console.log(
      `NOTE ${unchecked.length} production package(s) are platform-specific optional binaries that ` +
        `are not installed on this machine, so their licence was not read: ` +
        unchecked.map((r) => r.key).join(', '),
    );
  }

  const jsonOut = flag('--json');
  if (jsonOut) {
    mkdirSync(dirname(jsonOut), { recursive: true });
    const slim = rows.map(({ key, name, version, scope, license, status, note, integrity }) => ({
      key,
      name,
      version,
      scope,
      license,
      status,
      note,
      integrity,
    }));
    writeFileSync(
      jsonOut,
      `${JSON.stringify({ packages: slim, violations: violations.length }, null, 2)}\n`,
    );
  }
  const mdOut = flag('--markdown');
  if (mdOut) {
    mkdirSync(dirname(mdOut), { recursive: true });
    const lines = [
      '# Third-party licences',
      '',
      `Generated from pnpm-lock.yaml: ${rows.length} packages (${count((r) => r.scope === 'prod')} production).`,
      'Only production packages can end up in the extension bundle; tooling packages are listed for completeness.',
      '',
      '| Package | Version | Scope | Licence | Status |',
      '| --- | --- | --- | --- | --- |',
      ...rows.map(
        (r) =>
          `| ${r.name} | ${r.version} | ${r.scope} | ${r.license ?? 'not installed'} | ${r.status}${r.note ? `: ${r.note}` : ''} |`,
      ),
      '',
    ];
    writeFileSync(mdOut, lines.join('\n'));
  }

  if (violations.length > 0) {
    console.error(`\nLICENCE CHECK FAILED (${violations.length}):`);
    for (const r of violations) {
      console.error(`  ${r.key} [${r.scope}] ${r.license ?? '(none)'} - ${r.note}`);
    }
    console.error(
      'Fix the dependency, or add it to EXCEPTIONS in scripts/license-report.mjs with a reason.',
    );
    exit(1);
  }
  console.log('licence check ok');
}

main();

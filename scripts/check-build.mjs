// Release-gate assertions on the BUILT extension (run in CI after `pnpm build` and `pnpm build:e2e`).
// Fails loudly on any drift from the least-privilege / local-first contract (SECURITY_PRIVACY.md).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = process.env.SV_OUT_DIR ?? '.output';
const prod = join(out, 'chrome-mv3');
const e2e = join(out, 'chrome-mv3-e2e');
const failures = [];
const fail = (msg) => failures.push(msg);

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

if (!existsSync(join(prod, 'manifest.json'))) {
  console.error(`No production build at ${prod}. Run pnpm build first.`);
  process.exit(1);
}
const m = JSON.parse(readFileSync(join(prod, 'manifest.json'), 'utf8'));

// --- manifest: least privilege -------------------------------------------------------------
if (m.manifest_version !== 3) fail('not Manifest V3');
if (m.host_permissions?.length) fail(`host_permissions present: ${m.host_permissions}`);
if (m.content_scripts?.length)
  fail('static content_scripts present (must be registered at runtime)');
if (m.web_accessible_resources?.length) fail('web_accessible_resources present (page-probeable)');
if (m.externally_connectable) fail('externally_connectable present');
const perms = [...(m.permissions ?? [])].sort().join(',');
const wantPerms = 'activeTab,contextMenus,scripting,sidePanel,storage';
if (perms !== wantPerms) fail(`permissions "${perms}" != "${wantPerms}"`);
const optHosts = [...(m.optional_host_permissions ?? [])].sort().join(',');
if (optHosts !== 'http://*/*,https://*/*') fail(`optional_host_permissions "${optHosts}"`);
const csp = m.content_security_policy?.extension_pages ?? '';
const CONNECT_ALLOWED = new Set(["'self'", 'https:', 'http://localhost:*', 'http://127.0.0.1:*']);
const connectTokens = (/connect-src ([^;]+)/.exec(csp)?.[1] ?? '').trim().split(/\s+/);
for (const token of connectTokens) {
  if (!CONNECT_ALLOWED.has(token)) fail(`connect-src token not allow-listed: ${token}`);
}
for (const directive of [
  "script-src 'self' 'wasm-unsafe-eval'",
  "connect-src 'self'",
  "frame-src 'none'",
  "form-action 'none'",
]) {
  if (!csp.includes(directive)) fail(`extension_pages CSP is missing ${directive}: ${csp}`);
}
if (
  /(?<!wasm-)unsafe-eval|unsafe-inline/.test(csp) ||
  /(script|object|base|frame|form)-[a-z]+[^;]*https?:/.test(csp)
)
  fail(`extension_pages CSP is too loose: ${csp}`);
const commands = Object.keys(m.commands ?? {})
  .sort()
  .join(',');
const wantCommands = 'focus-toolbar,next-highlight,open-side-panel,previous-highlight,quick-save';
if (commands !== wantCommands) fail(`commands "${commands}" != "${wantCommands}"`);

// --- no remote code or assets in extension pages -------------------------------------------
for (const file of walk(prod).filter((f) => f.endsWith('.html'))) {
  const html = readFileSync(file, 'utf8');
  if (/<(script|link|img|iframe)[^>]+(src|href)=["']https?:/i.test(html))
    fail(`remote resource in ${file}`);
}
if (walk(prod).some((f) => f.endsWith('.map'))) fail('source maps are shipped');

// --- size budgets (regress guard; tighten as the lazy-mount work lands) ---------------------
const KB = 1024;
const size = (rel) => statSync(join(prod, rel)).size;
const budgets = [
  ['content-scripts/highlighter.js', 450 * KB],
  // The worker bundles @storage, which now includes the study, AI and sync repositories (they register
  // their table schemas at import time, so they are not tree-shaken). 420 KB is a regress guard.
  ['background.js', 420 * KB],
];
for (const [rel, max] of budgets) {
  if (!existsSync(join(prod, rel))) fail(`missing ${rel}`);
  else if (size(rel) > max)
    fail(`${rel} is ${Math.round(size(rel) / KB)} KB, budget ${Math.round(max / KB)} KB`);
}
// The OCR engine (wasm + traineddata, packages/ocr) is large by design and has its own budget below.
const ocrDir = join(prod, 'ocr');
const total = walk(prod)
  .filter((f) => !f.startsWith(ocrDir + sep))
  .reduce((n, f) => n + statSync(f).size, 0);
// Phase 1 shipped ~1.1 MB. PDF.js (worker, CJK character maps, standard fonts) and the new pages take
// the non-OCR total to ~5.3 MB; 6500 KB leaves room for the dashboard/review pages. OCR assets are
// budgeted separately above. Raise this only with a reason in the commit.
const TOTAL_BUDGET_KB = 6500;
if (total > TOTAL_BUDGET_KB * KB)
  fail(`total extension size ${Math.round(total / KB)} KB exceeds ${TOTAL_BUDGET_KB} KB`);

// --- OCR assets: exactly the audited files (packages/ocr/assets.manifest.json), within budget ---
// Generated into public/ocr by scripts/copy-ocr-assets.mjs (WXT module modules/ocr-assets.ts).
const OCR_BUDGET = 7 * 1024 * KB;
const ocrManifest = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../packages/ocr/assets.manifest.json', import.meta.url)),
    'utf8',
  ),
);
let ocrTotal = 0;
if (!existsSync(ocrDir)) {
  fail(
    'ocr/ is missing from the build (modules/ocr-assets.ts did not run scripts/copy-ocr-assets.mjs)',
  );
} else {
  const shipped = readdirSync(ocrDir).sort();
  const wanted = ocrManifest.files.map((f) => f.name).sort();
  if (shipped.join(',') !== wanted.join(',')) {
    fail(`ocr/ holds "${shipped}" but the manifest lists "${wanted}"`);
  }
  for (const file of ocrManifest.files) {
    const path = join(ocrDir, file.name);
    if (!existsSync(path)) continue;
    const data = readFileSync(path);
    ocrTotal += data.length;
    if (createHash('sha256').update(data).digest('hex') !== file.sha256) {
      fail(`ocr/${file.name} does not match the recorded sha-256`);
    }
  }
  if (ocrTotal > OCR_BUDGET) {
    fail(
      `OCR assets are ${Math.round(ocrTotal / KB)} KB, budget ${Math.round(OCR_BUDGET / KB)} KB`,
    );
  }
}

// --- the e2e variant must be the production React (a dev build hides real timing) -----------
if (existsSync(e2e)) {
  for (const file of walk(e2e).filter((f) => f.endsWith('.js'))) {
    if (readFileSync(file, 'utf8').includes('react-stack-top-frame'))
      fail(`React DEV build in ${file}`);
  }
}

if (failures.length) {
  console.error(`BUILD CHECK FAILED (${failures.length}):\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
console.log(
  `build ok: permissions=${perms}; optional hosts=${optHosts}; commands=${commands}; ` +
    `content script ${Math.round(size('content-scripts/highlighter.js') / KB)} KB; total ${Math.round(total / KB)} KB`,
);
console.log(
  `ocr assets ok: ${ocrManifest.files.length} files, ${Math.round(ocrTotal / KB)} KB (separate budget)`,
);

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
// Optional, runtime-requested only: sync sign-in and its timer (docs/adr/009). Anything else added here
// would be a new capability the user can be prompted for, so it must be a deliberate change to this pin.
const optPerms = [...(m.optional_permissions ?? [])].sort().join(',');
if (optPerms !== 'alarms,identity') fail(`optional_permissions "${optPerms}" != "alarms,identity"`);

// The extension-pages policy, directive by directive (docs/adr/009). Adding a source or a directive is
// a decision, so it changes this table in the same commit. Neither 'unsafe-inline' nor 'unsafe-eval'
// appears; connect-src is the only directive wider than 'self' (AI, sync, PDF from a web address);
// img-src data: is the reader's wavy-underline mask.
const WANT_CSP = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'wasm-unsafe-eval'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:'],
  'font-src': ["'self'"],
  'connect-src': ["'self'", 'https:', 'http://localhost:*', 'http://127.0.0.1:*'],
  'worker-src': ["'self'"],
  'media-src': ["'none'"],
  'manifest-src': ["'none'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'frame-src': ["'none'"],
  'form-action': ["'none'"],
};
const parseCsp = (text) =>
  Object.fromEntries(
    text
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...sources]) => [name, sources]),
  );
const csp = m.content_security_policy?.extension_pages ?? '';
const policy = parseCsp(csp);
for (const name of new Set([...Object.keys(WANT_CSP), ...Object.keys(policy)])) {
  const got = (policy[name] ?? ['<missing>']).join(' ');
  const want = (WANT_CSP[name] ?? ['<not allowed>']).join(' ');
  if (got !== want) fail(`CSP ${name} is "${got}", expected "${want}"`);
}
// Independent of the table above, in case it is edited carelessly: what may never appear, and where.
for (const [name, sources] of Object.entries(policy)) {
  const bad = sources.filter(
    (s) =>
      s === "'unsafe-eval'" ||
      s === '*' ||
      (s === "'unsafe-inline'" && name !== 'style-src') ||
      ((s === 'data:' || s === 'blob:') && name !== 'img-src') ||
      (/^https?:/.test(s) && name !== 'connect-src'),
  );
  if (bad.length) fail(`CSP ${name} must not carry ${bad.join(' ')}: ${csp}`);
}
const commands = Object.keys(m.commands ?? {})
  .sort()
  .join(',');
const wantCommands =
  'focus-search,focus-toolbar,next-highlight,open-side-panel,previous-highlight,quick-save';
// Chrome honours at most four suggested keys per extension; a fifth would be dropped silently.
const suggested = Object.values(m.commands ?? {}).filter((c) => c.suggested_key).length;
if (suggested > 4) fail(`${suggested} commands carry a suggested key; Chrome allows four`);
if (commands !== wantCommands) fail(`commands "${commands}" != "${wantCommands}"`);

// --- no remote code or assets in extension pages -------------------------------------------
for (const file of walk(prod).filter((f) => f.endsWith('.html'))) {
  const html = readFileSync(file, 'utf8');
  if (/<(script|link|img|iframe)[^>]+(src|href)=["']https?:/i.test(html))
    fail(`remote resource in ${file}`);
  // style-src 'self' and script-src 'self' refuse these at runtime, so a build that has them is broken.
  if (/<style[\s>]|\sstyle=["']/i.test(html)) fail(`inline style in ${file}`);
  if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(html)) fail(`inline script in ${file}`);
}
for (const file of walk(prod).filter((f) => f.endsWith('.css'))) {
  if (/@import|url\(\s*["']?(https?:)?\/\//i.test(readFileSync(file, 'utf8')))
    fail(`remote resource or @import in ${file}`);
}
if (walk(prod).some((f) => f.endsWith('.map'))) fail('source maps are shipped');

// --- size budgets (regress guard; tighten as the lazy-mount work lands) ---------------------
const KB = 1024;
const size = (rel) => statSync(join(prod, rel)).size;
const budgets = [
  // Preact in place of React (docs/adr/012): 405 KB -> 209 KB measured, budget = measured + 5%.
  ['content-scripts/highlighter.js', 220 * KB],
  // The worker bundles @storage, which includes the study, AI, sync, rules, syllabi and relations
  // repositories (they register their table schemas at import time, so they are not tree-shaken), plus
  // the filing, reminder and exam-free worker modules. 450 KB is a regress guard (measured ~425 KB).
  ['background.js', 450 * KB],
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
// Phase 1 shipped ~1.1 MB. PDF.js (worker, CJK character maps, standard fonts) and the pages take the
// non-OCR total to ~6.3 MB after the Preact content script (-200 KB, docs/adr/012). The finish wave
// (filing rules, syllabus, graph, AI router and chat, exam, reminders, import formats, backup folder,
// related, bounded Markdown) measured 6643 KB in Actions run 38165977562 before the rules UI landed, so
// 6800 KB leaves ~2% headroom. OCR assets are budgeted separately above. Raise this only with a reason
// in the commit.
const TOTAL_BUDGET_KB = 6800;
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

// --- test hooks must not ship ---------------------------------------------------------------
// The e2e build registers a message that lets the Playwright helpers change settings through the
// worker's updateSettings (entrypoints/background/e2e.ts, behind __SV_E2E__). Its name must not be
// in any production file; it must be in the e2e worker, or the helpers would silently stop working.
const E2E_HOOKS = ['e2e.settings.patch'];
for (const file of walk(prod).filter((f) => /\.(js|html)$/.test(f))) {
  const text = readFileSync(file, 'utf8');
  for (const hook of E2E_HOOKS) {
    if (text.includes(hook)) fail(`test hook "${hook}" is in the production build: ${file}`);
  }
}
if (existsSync(e2e)) {
  const shipped = walk(e2e)
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  for (const hook of E2E_HOOKS) {
    if (!shipped.includes(hook)) fail(`test hook "${hook}" is missing from the e2e build`);
  }
}

// --- the e2e variant must be the production React (a dev build hides real timing) -----------
if (existsSync(e2e)) {
  // ... and the manifest the e2e suite loads must be the shipped one, apart from loopback hosts.
  const me = JSON.parse(readFileSync(join(e2e, 'manifest.json'), 'utf8'));
  for (const key of [
    'permissions',
    'optional_permissions',
    'optional_host_permissions',
    'content_security_policy',
  ]) {
    if (JSON.stringify(me[key]) !== JSON.stringify(m[key]))
      fail(`e2e manifest ${key} differs from the production manifest`);
  }
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
  `build ok: permissions=${perms}; optional=${optPerms}; optional hosts=${optHosts}; ` +
    `csp directives=${Object.keys(policy).length}; commands=${commands}; ` +
    `content script ${Math.round(size('content-scripts/highlighter.js') / KB)} KB; total ${Math.round(total / KB)} KB`,
);
console.log(
  `ocr assets ok: ${ocrManifest.files.length} files, ${Math.round(ocrTotal / KB)} KB (separate budget)`,
);

// Release-gate assertions on the BUILT extension (run in CI after `pnpm build` and `pnpm build:e2e`).
// Fails loudly on any drift from the least-privilege / local-first contract (SECURITY_PRIVACY.md).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
for (const directive of [
  "script-src 'self'",
  "connect-src 'self'",
  "frame-src 'none'",
  "form-action 'none'",
]) {
  if (!csp.includes(directive)) fail(`extension_pages CSP is missing ${directive}: ${csp}`);
}
if (/unsafe-eval|unsafe-inline|https?:/.test(csp)) fail(`extension_pages CSP is too loose: ${csp}`);
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
  ['background.js', 320 * KB],
];
for (const [rel, max] of budgets) {
  if (!existsSync(join(prod, rel))) fail(`missing ${rel}`);
  else if (size(rel) > max)
    fail(`${rel} is ${Math.round(size(rel) / KB)} KB, budget ${Math.round(max / KB)} KB`);
}
const total = walk(prod).reduce((n, f) => n + statSync(f).size, 0);
if (total > 1800 * KB) fail(`total extension size ${Math.round(total / KB)} KB exceeds 1800 KB`);

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

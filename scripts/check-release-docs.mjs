// Keeps the store-facing documents honest about the BUILT manifest (SECURITY_PRIVACY.md "Publication
// readiness"). Run after `pnpm build`.
//
//   node scripts/check-release-docs.mjs [--strict]
//
// 1. Every permission and optional host permission in the built manifest must appear, in backticks,
//    in STORE_LISTING.md (justification) and PRIVACY_POLICY.md (what it means for data). Adding a
//    permission without updating both documents fails the build.
// 2. Every `[USER-REQUIRED: ...]` marker (a fact only the account owner can supply: support address,
//    hosted policy URL, store assets) is listed. With --strict any remaining marker fails: that is
//    the state a store submission must not be in. The marker is the bracketed form, so prose that
//    merely names it does not count. The scan also covers SECURITY.md (its contact marker),
//    README.md and LICENSE (the copyright holder's name) when they exist; those three are not held
//    to the permission table in step 1.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, env, exit } from 'node:process';

const strict = argv.includes('--strict');
const manifestPath = join(env.SV_OUT_DIR ?? '.output', 'chrome-mv3', 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`No production build at ${manifestPath}. Run pnpm build first.`);
  exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const docs = ['STORE_LISTING.md', 'PRIVACY_POLICY.md'].map((name) => {
  if (!existsSync(name)) {
    console.error(`${name} is missing.`);
    exit(1);
  }
  return { name, text: readFileSync(name, 'utf8') };
});
// Scanned for markers only: a missing file is not a failure (it is not a store document).
const markerOnly = ['SECURITY.md', 'README.md', 'LICENSE']
  .filter((name) => existsSync(name))
  .map((name) => ({ name, text: readFileSync(name, 'utf8') }));

const failures = [];
const declared = [
  ...(manifest.permissions ?? []),
  ...(manifest.optional_permissions ?? []),
  ...(manifest.host_permissions ?? []),
  ...(manifest.optional_host_permissions ?? []),
];
for (const permission of declared) {
  for (const { name, text } of docs) {
    if (!text.includes(`\`${permission}\``)) {
      failures.push(`${name} does not mention the manifest permission \`${permission}\``);
    }
  }
}

const open = [];
for (const { name, text } of [...docs, ...markerOnly]) {
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes('[USER-REQUIRED'))
      open.push(`${name}:${i + 1}: ${line.trim().slice(0, 140)}`);
  });
}
if (open.length > 0) {
  console.log(
    `${open.length} item(s) that only the account owner can supply:\n - ${open.join('\n - ')}`,
  );
  if (strict)
    failures.push(`${open.length} USER-REQUIRED [USER-REQUIRED] marker(s) remain (--strict)`);
}

if (failures.length > 0) {
  console.error(`RELEASE DOCS CHECK FAILED (${failures.length}):\n - ${failures.join('\n - ')}`);
  exit(1);
}
console.log(
  `release docs ok: ${declared.length} manifest permission(s) documented in ${docs.map((d) => d.name).join(' and ')}`,
);

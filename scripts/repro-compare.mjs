// Reproducible-build comparison: two builds of the same commit must produce the same files.
//
//   node scripts/repro-compare.mjs <A> <B> [--label "text"]
//
// A and B are each a directory (e.g. .output/chrome-mv3) or a .zip. A zip is compared by the hash of
// every entry, not by its own bytes, because the container carries timestamps and entry order that
// say nothing about the extension. Both inputs are the extension's own output, so every difference
// fails the check. Exit 0 = identical, 1 = differences, 2 = usage.
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { argv, env, exit } from 'node:process';
import { unzipSync } from 'fflate';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function load(input) {
  const files = new Map();
  if (statSync(input).isFile()) {
    for (const [name, data] of Object.entries(unzipSync(readFileSync(input)))) {
      if (!name.endsWith('/')) files.set(name, sha256(data));
    }
    return files;
  }
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, `${prefix}${entry.name}/`);
      else files.set(`${prefix}${entry.name}`, sha256(readFileSync(path)));
    }
  };
  walk(input, '');
  return files;
}

const [a, b] = argv.slice(2).filter((x) => !x.startsWith('--'));
if (!a || !b) {
  console.error('usage: node scripts/repro-compare.mjs <dir|zip> <dir|zip> [--label text]');
  exit(2);
}
const label = argv.includes('--label') ? argv[argv.indexOf('--label') + 1] : `${a} vs ${b}`;

const left = load(a);
const right = load(b);
const names = [...new Set([...left.keys(), ...right.keys()])].sort();
const diffs = names.filter((n) => left.get(n) !== right.get(n));
const short = (h) => (h ? h.slice(0, 12) : 'absent');

const lines = [
  `### Reproducible build: ${label}`,
  '',
  `${left.size} files in A, ${right.size} in B, ${names.length - diffs.length} identical.`,
  '',
  diffs.length === 0
    ? '**Identical: every file hashes the same in both builds.**'
    : `**${diffs.length} file(s) differ:**\n\n| File | A (sha256) | B (sha256) |\n| --- | --- | --- |\n${diffs
        .map((n) => `| ${n} | ${short(left.get(n))} | ${short(right.get(n))} |`)
        .join('\n')}`,
  '',
];
console.log(lines.join('\n'));
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
if (diffs.length > 0) exit(1);

// Seeded stress / performance runner (TEST_PLAN.md "Performance targets"). CI only: it is the job of
// .github/workflows/stress.yml, not something to run on a small developer machine (AGENTS.md Rule 1).
//
//   SV_PERF=1 node scripts/run-perf.mjs [--out perf-results] [--list] [--self-test]
//
// Finds the perf / stress / round-trip suites under packages/, entrypoints/ and server/, runs them
// through Vitest with SV_PERF=1 (the suites' own switch for their 10k-row variants) and writes
// timings.json plus a job-summary table. The latency budgets themselves are asserted inside the
// suites (so a regression fails that test); this runner adds three things a plain `vitest run` does
// not: skipped suites are a failure, a missing suite for an expected area is a failure, and coarse
// wall-time ceilings catch order-of-magnitude regressions that no assertion covers.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { argv, env, exit, platform, version } from 'node:process';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';

/** Packages that must ship a seeded perf suite (ROADMAP Phase 2/4 gates, TEST_PLAN budgets). */
const EXPECTED_AREAS = ['storage', 'search', 'study', 'backup'];
const SUITE =
  /(?:^|\/)(?:perf[\w.-]*|[\w.-]*\.perf|stress[\w.-]*|[\w.-]*round-?trip[\w.-]*)\.test\.tsx?$/;
const DOM_AREAS = new Set(['highlights', 'ui']);
const TEST_CEILING_MS = Number(env.SV_PERF_TEST_MS ?? 120_000);
const FILE_CEILING_MS = Number(env.SV_PERF_FILE_MS ?? 300_000);

function findSuites(root = '.') {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (SUITE.test(path)) found.push(path);
    }
  };
  for (const top of ['packages', 'entrypoints', 'server']) {
    try {
      walk(top);
    } catch {
      /* folder does not exist (yet) */
    }
  }
  return found.sort();
}

const areaOf = (file) => (file.startsWith('packages/') ? file.split('/')[1] : file.split('/')[0]);

function environmentOf(file, root = '.') {
  const head = readFileSync(join(root, file), 'utf8').slice(0, 2048);
  if (/@vitest-environment\s+\w+/.test(head)) return 'file'; // the file chooses; the CLI default is irrelevant
  return DOM_AREAS.has(areaOf(file)) || file.endsWith('.tsx') ? 'jsdom' : 'node';
}

/** Turns Vitest JSON reports into rows and a list of problems. Pure, so it can be self-tested. */
function analyse(reports, files) {
  const rows = [];
  const problems = [];
  for (const report of reports) {
    for (const suite of report.testResults ?? []) {
      const file = relative(process.cwd(), suite.name).split('\\').join('/');
      const wallMs = Math.max(0, (suite.endTime ?? 0) - (suite.startTime ?? 0));
      const tests = suite.assertionResults ?? [];
      for (const t of tests) {
        rows.push({
          area: areaOf(file),
          file,
          test: t.fullName,
          status: t.status,
          ms: Math.round(t.duration ?? 0),
        });
        if (t.status === 'failed') {
          problems.push(
            `${file}: "${t.title}" failed: ${(t.failureMessages?.[0] ?? '').split('\n')[0]}`,
          );
        }
        if ((t.duration ?? 0) > TEST_CEILING_MS) {
          problems.push(
            `${file}: "${t.title}" took ${Math.round(t.duration)} ms (ceiling ${TEST_CEILING_MS})`,
          );
        }
      }
      const ran = tests.filter((t) => t.status === 'passed' || t.status === 'failed').length;
      if (ran === 0) {
        problems.push(
          `${file}: no test ran (skipped or empty). Is SV_PERF=1 honoured by this suite?`,
        );
      }
      if (wallMs > FILE_CEILING_MS) {
        problems.push(`${file}: ran ${wallMs} ms (ceiling ${FILE_CEILING_MS})`);
      }
    }
  }
  const seen = new Set(rows.map((r) => r.file));
  for (const file of files) {
    if (!seen.has(file)) problems.push(`${file}: Vitest produced no result for this file`);
  }
  for (const area of EXPECTED_AREAS) {
    if (!files.some((f) => areaOf(f) === area)) {
      problems.push(`no perf / stress / round-trip suite found for packages/${area}`);
    }
  }
  return { rows, problems };
}

function selfTest() {
  const report = {
    testResults: [
      {
        name: `${process.cwd()}/packages/storage/src/perf.test.ts`,
        startTime: 0,
        endTime: 500,
        assertionResults: [
          { fullName: 'a b', title: 'b', status: 'passed', duration: 12.4 },
          {
            fullName: 'a c',
            title: 'c',
            status: 'failed',
            duration: 3,
            failureMessages: ['boom\nstack'],
          },
        ],
      },
      {
        name: `${process.cwd()}/packages/search/src/perf.test.ts`,
        startTime: 0,
        endTime: 10,
        assertionResults: [{ fullName: 'x', title: 'x', status: 'skipped', duration: 0 }],
      },
    ],
  };
  const { rows, problems } = analyse(
    [report],
    ['packages/storage/src/perf.test.ts', 'packages/search/src/perf.test.ts'],
  );
  const expect = (cond, what) => {
    if (!cond) throw new Error(`self-test: ${what}`);
  };
  expect(rows.length === 3, 'three rows');
  expect(
    problems.some((p) => p.includes('"c" failed: boom')),
    'failure reported',
  );
  expect(
    problems.some((p) => p.includes('search/src/perf.test.ts: no test ran')),
    'skip reported',
  );
  expect(
    problems.some((p) => p.includes('packages/study')),
    'missing area reported',
  );
  expect(
    problems.some((p) => p.includes('packages/backup')),
    'missing area reported',
  );
  expect(areaOf('packages/highlights/src/perf.test.ts') === 'highlights', 'area');
  expect(SUITE.test('packages/storage/src/perf.test.ts'), 'pattern perf');
  expect(SUITE.test('packages/backup/src/roundtrip.test.ts'), 'pattern round trip');
  expect(!SUITE.test('packages/storage/src/repo.test.ts'), 'pattern ignores ordinary tests');
  console.log('run-perf self-test ok');
}

function main() {
  if (argv.includes('--self-test')) return selfTest();
  const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'perf-results';

  const files = findSuites();
  console.log(`perf suites found (${files.length}):\n  ${files.join('\n  ') || '(none)'}`);
  const groups = new Map();
  for (const file of files) {
    const key = environmentOf(file);
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }

  if (argv.includes('--list')) {
    for (const [environment, group] of groups) console.log(`${environment}: ${group.join(' ')}`);
    return;
  }

  mkdirSync(out, { recursive: true });
  const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
  const reports = [];
  const crashed = [];
  for (const [environment, group] of groups) {
    const report = join(out, `vitest-${environment}.json`);
    const args = ['run', '--reporter=default', '--reporter=json', `--outputFile.json=${report}`];
    if (environment !== 'file') args.push('--environment', environment);
    console.log(`\n== vitest (${environment}): ${group.length} file(s)`);
    const result = spawnSync(process.execPath, [vitest, ...args, ...group], {
      stdio: 'inherit',
      env: { ...env, SV_PERF: '1' },
      timeout: 40 * 60_000,
    });
    try {
      reports.push(JSON.parse(readFileSync(report, 'utf8')));
    } catch {
      crashed.push(
        `vitest (${environment}) exited ${result.status ?? result.signal} without a report`,
      );
    }
  }

  const { rows, problems } = analyse(reports, files);
  problems.push(...crashed);
  const summary = {
    generatedAt: new Date().toISOString(),
    commit: env.GITHUB_SHA ?? null,
    ref: env.GITHUB_REF_NAME ?? null,
    node: version,
    platform,
    cpus: cpus().length,
    ceilings: { testMs: TEST_CEILING_MS, fileMs: FILE_CEILING_MS },
    expectedAreas: EXPECTED_AREAS,
    results: rows,
    problems,
  };
  writeFileSync(join(out, 'timings.json'), `${JSON.stringify(summary, null, 2)}\n`);

  const table = [
    '### Seeded perf / stress suites (SV_PERF=1)',
    '',
    `Node ${version} on ${platform}, ${cpus().length} CPUs. Latency budgets are asserted inside the suites; ` +
      `ceilings here: ${TEST_CEILING_MS} ms per test, ${FILE_CEILING_MS} ms per file.`,
    '',
    '| Area | Test | Status | ms |',
    '| --- | --- | --- | ---: |',
    ...rows.map(
      (r) => `| ${r.area} | ${r.file.split('/').pop()} - ${r.test} | ${r.status} | ${r.ms} |`,
    ),
    '',
    problems.length === 0
      ? '**All suites ran and passed.**'
      : `**${problems.length} problem(s):**\n\n${problems.map((p) => `- ${p}`).join('\n')}`,
    '',
  ].join('\n');
  writeFileSync(join(out, 'summary.md'), table);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${table}\n`);

  if (problems.length > 0) {
    console.error(`\nPERF RUN FAILED (${problems.length}):\n - ${problems.join('\n - ')}`);
    exit(1);
  }
  console.log(`\nperf run ok: ${rows.length} tests, results in ${out}/`);
}

main();

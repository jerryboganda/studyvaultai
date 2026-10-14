/* global process, console, URL, URLSearchParams, fetch, setTimeout, document, window */
/**
 * Screenshots every gallery page x state x scenario x theme (gallery/catalog.json) with Playwright's
 * Chromium, one browser, one page at a time (light on purpose: no extension is loaded).
 *
 *   node gallery/capture.mjs [--url http://localhost:5199] [--port 5199] [--out .ci-artifacts/gallery]
 *                            [--surface popup,sidepanel] [--scenario student] [--state default]
 *
 * Without --url it starts the gallery's Vite dev server and stops it at the end. Writes
 * <out>/<scenario>/<surface>[-<state>]-<theme>[-w<width>].png and <out>/report.json (console errors
 * and warnings, page errors and failed requests per shot). Exits 1 when a shot has an uncaught page
 * error, did not reach its state, or rendered blank.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repo = fileURLToPath(new URL('..', import.meta.url));
const catalog = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'));

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const list = (name) => (args.has(name) ? new Set(args.get(name).split(',')) : null);
const only = { surface: list('surface'), scenario: list('scenario'), state: list('state') };
const filtered = Boolean(only.surface || only.scenario || only.state);
const port = Number(args.get('port') ?? 5199);
const out = path.resolve(repo, args.get('out') ?? '.ci-artifacts/gallery');
const THEMES = ['light', 'dark'];
/** Taller full-page shots are cut here (the settings page is ~16,000 px). */
const MAX_HEIGHT = 4000;
const LOAD_TIMEOUT = 90_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  const vite = path.join(repo, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(
    process.execPath,
    [vite, '--config', 'gallery/vite.config.ts', '--port', String(port), '--strictPort'],
    { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`Vite exited:\n${log}`);
    try {
      if ((await fetch(`${base}/pages/popup.html`)).ok) return { base, child };
    } catch {
      /* not listening yet */
    }
    await sleep(500);
  }
  child.kill();
  throw new Error(`Vite did not start on ${base}:\n${log}`);
}

/** Every load to make: one per surface x state x scenario (themes and widths share the load). */
function plan() {
  const loads = [];
  for (const surface of catalog.surfaces) {
    if (only.surface && !only.surface.has(surface.id)) continue;
    for (const state of surface.states) {
      if (only.state && !only.state.has(state.id)) continue;
      for (const scenario of state.scenarios ?? surface.scenarios) {
        if (only.scenario && !only.scenario.has(scenario)) continue;
        loads.push({ surface, state, scenario });
      }
    }
  }
  return loads;
}

async function main() {
  const server = args.has('url')
    ? { base: args.get('url').replace(/\/$/, ''), child: null }
    : await startServer();
  // A filtered run (--surface/--scenario/--state) refreshes its own files and keeps the rest.
  if (!filtered) rmSync(out, { recursive: true, force: true });
  const browser = await chromium.launch();
  const shots = [];
  try {
    const loads = plan();
    console.log(`Capturing ${loads.length} page loads from ${server.base}`);
    for (const [i, load] of loads.entries()) {
      const started = Date.now();
      const taken = await captureLoad(browser, server.base, load);
      shots.push(...taken);
      const bad = taken.filter((s) => s.failed).length;
      console.log(
        `[${i + 1}/${loads.length}] ${load.scenario}/${load.surface.id}/${load.state.id}: ${taken.length} shots, ${bad ? `${bad} FAILED` : 'ok'} (${Date.now() - started} ms)`,
      );
    }
  } finally {
    await browser.close();
    server.child?.kill();
  }

  const failed = shots.filter((s) => s.failed);
  const reportFile = path.join(out, 'report.json');
  // A filtered run replaces its own entries in an earlier report and keeps the others.
  const files = new Set(shots.map((s) => s.file));
  const earlier =
    filtered && existsSync(reportFile)
      ? JSON.parse(readFileSync(reportFile, 'utf8')).shots.filter((s) => !files.has(s.file))
      : [];
  const all = [...earlier, ...shots];
  const report = {
    createdAt: new Date().toISOString(),
    base: server.base,
    summary: {
      shots: all.length,
      failed: all.filter((s) => s.failed).length,
      withConsoleErrors: all.filter((s) => s.consoleErrors.length).length,
      withPageErrors: all.filter((s) => s.pageErrors.length).length,
      withFailedRequests: all.filter((s) => s.failedRequests.length).length,
    },
    shots: all,
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `This run: ${shots.length} shots, ${failed.length} failed. Report: ${JSON.stringify(report.summary)}`,
  );
  for (const s of failed) console.log(`FAILED ${s.file}: ${s.problems.join('; ')}`);
  process.exitCode = failed.length ? 1 : 0;
}

async function captureLoad(browser, base, { surface, state, scenario }) {
  const query = new URLSearchParams({ scenario, theme: 'light' });
  if (state.id !== 'default') query.set('state', state.id);
  const url = `${base}/pages/${surface.id}.html?${query}`;
  const context = await browser.newContext({ viewport: surface.viewport });
  const page = await context.newPage();
  // Collected per shot: what happened since the previous shot of this load (the first gets the load).
  let events = { consoleErrors: [], consoleWarnings: [], pageErrors: [], failedRequests: [] };
  page.on('console', (m) => {
    if (m.type() === 'error') events.consoleErrors.push(m.text());
    else if (m.type() === 'warning') events.consoleWarnings.push(m.text());
  });
  page.on('pageerror', (e) => events.pageErrors.push(String(e.stack ?? e)));
  page.on('requestfailed', (r) =>
    events.failedRequests.push(`${r.url()} (${r.failure()?.errorText ?? 'failed'})`),
  );
  page.on('response', (r) => {
    if (r.status() >= 400) events.failedRequests.push(`${r.url()} (HTTP ${r.status()})`);
  });

  const shots = [];
  let reached = 'not loaded';
  try {
    await page.goto(url, { waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForSelector('html[data-gallery="mounted"], html[data-gallery="error"]', {
      timeout: LOAD_TIMEOUT,
    });
    reached = await page.evaluate(() => document.documentElement.dataset.gallery);
    await settle(page);
  } catch (err) {
    events.pageErrors.push(`Gallery: ${err instanceof Error ? err.message : String(err)}`);
  }

  const dir = path.join(out, scenario);
  mkdirSync(dir, { recursive: true });
  const fullPage = state.fullPage ?? surface.fullPage;
  const widths = [surface.viewport.width, ...(surface.widths ?? [])];
  for (const theme of THEMES) {
    let themeProblem = null;
    if (theme !== 'light' && reached === 'mounted') {
      themeProblem = await page
        .evaluate(async (t) => {
          await window.__gallery?.setTheme?.(t);
          return null;
        }, theme)
        .catch((err) => `theme switch failed: ${err.message}`);
      await settle(page);
      const applied = await page.evaluate(() => document.documentElement.dataset.theme);
      if (!themeProblem && applied !== theme) themeProblem = `html[data-theme] is "${applied}"`;
    }
    for (const width of widths) {
      if (width !== page.viewportSize().width) {
        await page.setViewportSize({ width, height: surface.viewport.height });
        await settle(page);
      }
      const name = `${surface.id}${state.id === 'default' ? '' : `-${state.id}`}-${theme}${width === surface.viewport.width ? '' : `-w${width}`}.png`;
      const file = path.join(dir, name);
      const blank = await isBlank(page);
      try {
        await shoot(page, file, fullPage);
      } catch (err) {
        events.pageErrors.push(`Screenshot: ${err.message}`);
      }
      const problems = [
        ...(reached === 'mounted'
          ? []
          : [`page did not reach its state (data-gallery=${reached})`]),
        ...(blank ? ['blank render'] : []),
        ...(events.pageErrors.length ? ['uncaught page error'] : []),
        ...(themeProblem ? [themeProblem] : []),
      ];
      shots.push({
        file: path.relative(out, file).replaceAll('\\', '/'),
        surface: surface.id,
        state: state.id,
        scenario,
        theme,
        width,
        url,
        failed: problems.length > 0,
        problems,
        ...events,
      });
      events = { consoleErrors: [], consoleWarnings: [], pageErrors: [], failedRequests: [] };
    }
    if (widths.length > 1) await page.setViewportSize(surface.viewport);
  }
  await context.close();
  return shots;
}

/** Lazy chunks and the in-page database have settled: no request for a while, then one more beat. */
async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await sleep(600);
}

/** Nothing readable on the page (the overlay page counts its shadow root). */
function isBlank(page) {
  return page.evaluate(() => {
    const text = (el) => (el?.innerText ?? '').trim().length;
    const shadow = document
      .querySelector('studyvault-overlay')
      ?.shadowRoot?.querySelector('.sv-root');
    return text(document.getElementById('root') ?? document.body) < 20 && text(shadow) === 0;
  });
}

async function shoot(page, file, fullPage) {
  if (!fullPage) return page.screenshot({ path: file, animations: 'disabled' });
  const { width, height } = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.scrollHeight,
  }));
  return page.screenshot({
    path: file,
    animations: 'disabled',
    fullPage: true,
    clip: { x: 0, y: 0, width, height: Math.min(height, MAX_HEIGHT) },
  });
}

await main();

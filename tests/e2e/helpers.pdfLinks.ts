import type { BrowserContext, Locator, Page } from '@playwright/test';
import { expect, type Env } from './helpers.pages';
import { openReader, type Reader } from './helpers.pdfReal';

/**
 * Helpers for pdf-links.spec.ts: the real reader in real Chromium, real mouse and keyboard input.
 * The link anchors take no pointer events (a click is caught on the page and matched to the link by
 * geometry), so a test follows a link the way a person does: it moves the real mouse to the middle
 * of the anchor and clicks there.
 */

/** A generated or real file, chosen through the real file chooser behind "Choose a PDF". */
export async function openBytes(env: Env, name: string, bytes: Buffer): Promise<Reader> {
  const reader = await openReader(env);
  const [chooser] = await Promise.all([
    reader.page.waitForEvent('filechooser'),
    reader.page.getByTestId('pdf-choose-file').click(),
  ]);
  await chooser.setFiles({ name, mimeType: 'application/pdf', buffer: bytes });
  await expect(reader.page.getByTestId('pdf-viewer')).toBeVisible({ timeout: 60_000 });
  return reader;
}

/** The link anchors of page `n` (they exist only while the page is drawn). */
export const anchorsOf = (page: Page, n: number): Locator =>
  page.locator(`[data-testid="pdf-page-${n}"] .sv-pdf-layer--links a[role="link"]`);

/** Accessible names of the anchors of page `n`, in DOM (= reading) order. */
export async function labelsOf(page: Page, n: number): Promise<string[]> {
  return anchorsOf(page, n).evaluateAll((els) =>
    els.map((el) => el.getAttribute('aria-label') ?? ''),
  );
}

/** Screen box of an element, after bringing it to the middle of the viewer (instantly). */
export async function boxOf(locator: Locator): Promise<Box> {
  await locator.evaluate((el) =>
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }),
  );
  // Scrolling can make the lazy window draw neighbours and move things; read the box once it holds still.
  let previous: Box | null = null;
  await expect
    .poll(
      async () => {
        const b = await locator.boundingBox();
        const now = b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
        const same =
          now !== null &&
          previous !== null &&
          Math.abs(now.x - previous.x) + Math.abs(now.y - previous.y) < 0.5;
        previous = now;
        return same;
      },
      { message: 'the element stops moving' },
    )
    .toBe(true);
  return previous as unknown as Box;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Click the middle of an anchor with the real mouse. */
export async function clickLink(page: Page, anchor: Locator): Promise<void> {
  const b = await boxOf(anchor);
  await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2);
  await page.mouse.down();
  await page.mouse.up();
}

/** What was said through the surface's polite status region. */
export const spoken = (page: Page): Locator => page.locator('.sv-toasts__polite');

/**
 * Answer every address the tests may open with a stub page, so nothing leaves the machine. Returns the
 * addresses that were requested.
 */
export async function stubWeb(context: BrowserContext): Promise<string[]> {
  const requested: string[] = [];
  await context.route(
    /^https?:\/\/(example\.org|www\.nist\.gov|other\.example)(:\d+)?\//,
    (route) => {
      requested.push(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>Stub</title><p>A stand-in for the linked site.</p>',
      });
    },
  );
  return requested;
}

/** The anchor's box and the box of the text it should cover overlap by at least `share` of the text. */
export function overlapShare(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? (w * h) / (b.w * b.h) : 0;
}

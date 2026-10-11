import type { Locator, Page } from '@playwright/test';
import {
  buildDataset,
  ensureVault,
  openControl,
  writeDataset,
  type DatasetInput,
  type Env,
} from './helpers.dashboard';

/**
 * Helpers for related.spec.ts: a small pharmacology vault whose relations can be read off the words,
 * and locators for the Related section of the dashboard preview.
 *
 * Words shared with W1 ("Warfarin ... vitamin K ... INR"):
 *   W2 warfarin, INR, vitamin (three)   W5 warfarin, vitamin (two)   W4 warfarin, INR (trashed)
 *   W3 and V1 share none.
 * W1 and W5 are from the same page, so "hide highlights from the same source" removes W5.
 */
export const TEXT = {
  w1: 'Warfarin inhibits vitamin K epoxide reductase and prolongs the INR.',
  w2: 'Bleeding on warfarin is monitored by the INR and by dietary vitamin K intake.',
  w3: 'Heparin activates antithrombin and is monitored by the aPTT.',
  w4: 'Warfarin and the INR in pregnancy are managed with heparin.',
  w5: 'Vitamin K reverses the effect of warfarin within hours.',
  v1: 'The mitral valve separates the left atrium from the left ventricle.',
} as const;

export function relatedInput(env: Env): DatasetInput {
  const url = (name: string) => `${env.origin}/dash-source-a.html?related=${name}`;
  return {
    sources: [
      { key: 'pharm', url: url('pharm'), title: 'Anticoagulants' },
      { key: 'clinic', url: url('clinic'), title: 'Clinical monitoring' },
      { key: 'heparin', url: url('heparin'), title: 'Heparins' },
      { key: 'heart', url: url('heart'), title: 'Cardiac anatomy' },
    ],
    highlights: [
      { key: 'w1', quote: TEXT.w1, source: 'pharm' },
      { key: 'w5', quote: TEXT.w5, source: 'pharm' },
      { key: 'w2', quote: TEXT.w2, source: 'clinic' },
      { key: 'w4', quote: TEXT.w4, source: 'clinic', trashed: true },
      { key: 'w3', quote: TEXT.w3, source: 'heparin' },
      { key: 'v1', quote: TEXT.v1, source: 'heart' },
    ],
  };
}

/** A vault written through the raw writer, ready for the first dashboard load. */
export async function seedRelated(env: Env) {
  const ctrl = await openControl(env);
  await ensureVault(ctrl);
  const ds = buildDataset(relatedInput(env));
  await writeDataset(ctrl, ds);
  return { ctrl, ds };
}

export const relatedSection = (page: Page): Locator => page.getByTestId('preview-related');
export const relatedToggle = (page: Page): Locator =>
  relatedSection(page).getByTestId('related-toggle');
export const relatedItems = (page: Page): Locator =>
  relatedSection(page).getByTestId('related-item');

/** Highlight ids of the listed related items, in order. */
export async function relatedIds(page: Page): Promise<string[]> {
  return relatedItems(page).evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-highlight-id') ?? ''),
  );
}

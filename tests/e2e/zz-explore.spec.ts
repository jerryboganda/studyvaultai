import AxeBuilder from '@axe-core/playwright';
import { expect, test, layoutReport } from './helpers.pages';

const OUT = 'C:/Users/Admin/AppData/Local/Temp/claude/D--Projects-StudyVault-AI/eb08ca0d-139f-4090-aa25-4e7647f05278/scratchpad';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

test('explore options', async ({ env }) => {
  const page = await env.context.newPage();
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto(`chrome-extension://${env.extensionId}/options.html`);
  await expect(page.getByText('Loading settings')).toHaveCount(0);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/options-desktop.png` });
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  console.log('AXE options', JSON.stringify(res.violations.map((v) => ({ id: v.id, n: v.nodes.map((n) => n.target.join(' ') + ' :: ' + n.html.slice(0, 120)) })), null, 1));
  await page.setViewportSize({ width: 320, height: 700 });
  await page.waitForTimeout(300);
  const rep = await layoutReport(page);
  console.log('LAYOUT 320', JSON.stringify(rep));
  const wide = await page.evaluate(() => {
    const w = window.innerWidth;
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > w + 1) {
        out.push(`${el.localName}.${el.className} #${el.id} right=${Math.round(r.right)} w=${Math.round(r.width)} :: ${(el.textContent ?? '').trim().slice(0, 50)}`);
      }
    }
    return out.slice(0, 25);
  });
  console.log('WIDE', JSON.stringify(wide, null, 1));
  console.log('ERRORS', JSON.stringify(errors));
});

test('explore onboarding', async ({ env }) => {
  const page = await env.context.newPage();
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto(`chrome-extension://${env.extensionId}/onboarding.html`);
  const names = ['welcome', 'privacy', 'access', 'banks', 'look', 'keys', 'done'];
  for (let i = 0; i < names.length; i++) {
    await expect(page.getByTestId(`ob-step-${names[i]}`)).toBeVisible();
    if (names[i] === 'banks') {
      await page.getByTestId('ob-preset-radiology').click();
    }
    await page.screenshot({ path: `${OUT}/ob-${i}-${names[i]}.png` });
    const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    console.log('AXE ob', names[i], JSON.stringify(res.violations.map((v) => ({ id: v.id, n: v.nodes.map((n) => n.target.join(' ') + ' :: ' + n.html.slice(0, 120)) }))));
    await page.setViewportSize({ width: 320, height: 700 });
    const rep = await layoutReport(page);
    console.log('LAYOUT ob 320', names[i], JSON.stringify(rep));
    await page.setViewportSize({ width: 900, height: 800 });
    if (i < names.length - 1) {
      if (names[i] === 'banks') {
        await page.getByTestId('ob-create').click();
        await expect(page.getByTestId('ob-applied')).toBeVisible();
      }
      await page.getByRole("button", { name: /^(Next|Start)$/ }).click();
    }
  }
  console.log('ERRORS', JSON.stringify(errors));
});

test('explore popup', async ({ env }) => {
  const page = await env.context.newPage();
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto(`chrome-extension://${env.extensionId}/popup.html`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/popup.png`, fullPage: true });
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  console.log('AXE popup', JSON.stringify(res.violations.map((v) => ({ id: v.id, n: v.nodes.map((n) => n.target.join(' ') + ' :: ' + n.html.slice(0, 120)) }))));
  console.log('LAYOUT popup', JSON.stringify(await layoutReport(page)));
});

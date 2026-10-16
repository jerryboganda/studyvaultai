import { createBank } from '@storage';
import { DAY, HOUR, ago, atTime, capture, completeOnboarding, type Scenario } from './kit';
import { TAB_PRESETS } from './tabs';

/**
 * Popup / side panel edge states. Pick the tab with `?tab=`: `chrome` (default, a browser page),
 * `denied` (default deny list), `inactive` (no site access yet, saved highlights exist), `pdf`,
 * `newtab` (no address), `none` (no active tab) or any address.
 */
export const edge: Scenario = {
  id: 'edge',
  title: 'Edge states: restricted, deny-listed and not-yet-enabled pages',
  tab: 'chrome',
  async seed() {
    await completeOnboarding();
    const bank = await atTime(ago(20 * DAY), () => createBank('Cardiology'));
    const page = TAB_PRESETS.inactive!;
    const quotes = [
      'Atrial fibrillation is the most common sustained arrhythmia in adults.',
      'Assess stroke risk with CHA2DS2-VASc and bleeding risk before starting anticoagulation.',
      'Rate control is the initial strategy for most stable patients.',
    ];
    for (const [i, quote] of quotes.entries()) {
      await capture({
        url: page.url!,
        title: page.title,
        quote,
        at: ago(10 * DAY) + i * HOUR,
        bankId: bank.id,
        kind: i === 1 ? 'exception' : 'essential',
      });
    }
  },
};

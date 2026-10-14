import type { Scenario } from './kit';

/** Just installed: no data, no site access, the welcome tour not done. */
export const fresh: Scenario = {
  id: 'fresh',
  title: 'Just installed: nothing saved, tour not taken',
  tab: 'inactive',
  async seed() {},
};

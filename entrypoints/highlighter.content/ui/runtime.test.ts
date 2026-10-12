import * as react from 'react';
import * as compat from 'preact/compat';
import { describe, expect, it } from 'vitest';

describe('overlay runtime (docs/adr/012)', () => {
  it('resolves react to preact/compat, as the content script bundle does', () => {
    // vitest.config.ts redirects `react` imports made from this folder; every other suite keeps React.
    expect(react.createElement).toBe(compat.createElement);
    expect(react.useSyncExternalStore).toBe(compat.useSyncExternalStore);
  });
});

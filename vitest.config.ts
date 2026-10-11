import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    environment: 'jsdom',
    include: [
      'packages/**/*.test.ts',
      'packages/**/*.test.tsx',
      'entrypoints/**/*.test.ts',
      'entrypoints/**/*.test.tsx',
      'server/**/*.test.ts',
    ],
    restoreMocks: true,
    // Several suites build 5k-10k row fixtures; a loaded CI runner must not turn that into a flake.
    testTimeout: 30_000,
  },
});

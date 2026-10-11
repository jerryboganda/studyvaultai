// Builds the e2e variant of the extension (see the E2E flag in wxt.config.ts).
// An env flag set from a script keeps this identical on Windows, macOS and Linux CI.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// `wxt/bin/wxt.mjs` is not in the package's export map, so resolve it by path.
const wxtBin = fileURLToPath(new URL('../node_modules/wxt/bin/wxt.mjs', import.meta.url));
const result = spawnSync(process.execPath, [wxtBin, 'build'], {
  stdio: 'inherit',
  env: { ...process.env, SV_E2E: '1' },
});
process.exit(result.status ?? 1);

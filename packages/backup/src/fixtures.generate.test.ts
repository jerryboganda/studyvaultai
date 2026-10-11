// @vitest-environment node
//
// Regenerates src/fixtures/*.json (the FROZEN archives migration.test.ts reads). Run only when a
// fixture is deliberately added:
//
//   SV_REGEN_FIXTURES=1 pnpm exec vitest run packages/backup/src/fixtures.generate.test.ts
//
// Never regenerate an existing fixture: the point is that archives written by an OLD exporter keep
// restoring with every newer importer. Without the variable this file defines no tests.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportBackup } from './export';
import { legacyData, legacyRegistry } from './legacyModel';
import { MemoryVault, fastKdf, fixedRandom, subtle } from './testkit';

const enabled = process.env.SV_REGEN_FIXTURES === '1';

describe.runIf(enabled)('fixture generator', () => {
  const dir = resolve(__dirname, 'fixtures');
  const now = () => new Date('2026-10-01T00:00:00.000Z');
  const make = async (
    file: string,
    description: string,
    version: 1 | 2 | 3,
    passphrase?: string,
  ) => {
    const vault = new MemoryVault(legacyData(version), { registry: legacyRegistry(version) });
    const out = await exportBackup(vault, {
      subtle,
      now,
      appVersion: `0.${version}.0-fixture`,
      randomBytes: fixedRandom,
      ...(passphrase ? { passphrase, ...fastKdf } : {}),
    });
    const counts = Object.fromEntries(out.manifest.tables.map((t) => [t.name, t.rowCount]));
    writeFileSync(
      resolve(dir, file),
      `${JSON.stringify(
        {
          description,
          formatVersion: 1,
          appSchemaVersion: version,
          encrypted: Boolean(passphrase),
          passphrase: passphrase ?? null,
          manifestChecksum: out.manifest.checksum,
          counts,
          base64: Buffer.from(out.bytes).toString('base64'),
        },
        null,
        2,
      )}\n`,
    );
    expect(out.manifest.appSchemaVersion).toBe(version);
  };

  it('v1 plain', () => make('v1-plain.json', 'Frozen: format 1, data schema 1, no encryption.', 1));
  it('v2 plain', () =>
    make('v2-plain.json', 'Frozen: format 1, data schema 2 (adds notes), no encryption.', 2));
  it('v3 encrypted', () =>
    make(
      'v3-encrypted.json',
      'Frozen: format 1, data schema 3, passphrase container (PBKDF2 1000 iterations).',
      3,
      'frozen fixture passphrase',
    ));
});

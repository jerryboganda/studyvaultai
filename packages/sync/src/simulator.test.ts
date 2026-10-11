// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { NO_FAULTS } from './testing/harness.ts';
import { runSimulation } from './testing/simulator.ts';

describe('multi-device simulator (seeded: a failure names its seed)', () => {
  it('converges with no lost text and no changed provenance under loss, duplication and reordering', async () => {
    const failures: string[] = [];
    let conflicts = 0;
    let resolutions = 0;
    let deletes = 0;
    let resurrections = 0;
    let forged = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const out = await runSimulation({ seed, devices: 3, steps: 160 });
      conflicts += out.stats.conflicts;
      resolutions += out.stats.resolutions;
      deletes += out.stats.deletes;
      resurrections += out.stats.resurrections;
      forged += out.stats.forged;
      if (out.violations.length)
        failures.push(`seed ${seed}: ${out.violations.slice(0, 4).join('\n  ')}`);
    }
    expect(failures, failures.join('\n')).toEqual([]);
    // The scenarios must actually exercise the hard paths, otherwise "no violations" proves nothing.
    expect(conflicts).toBeGreaterThan(20);
    expect(resolutions).toBeGreaterThan(5);
    expect(deletes).toBeGreaterThan(20);
    expect(resurrections).toBeGreaterThan(3);
    expect(forged).toBeGreaterThan(3);
  }, 120_000);

  it('also holds with five devices and a clean network', async () => {
    const failures: string[] = [];
    for (let seed = 1000; seed < 1015; seed++) {
      const out = await runSimulation({
        seed,
        devices: 5,
        steps: 200,
        faults: NO_FAULTS,
        maxSkewMs: 10 * 60 * 1000,
      });
      if (out.violations.length)
        failures.push(`seed ${seed}: ${out.violations.slice(0, 4).join('\n  ')}`);
    }
    expect(failures, failures.join('\n')).toEqual([]);
  }, 120_000);

  it('is deterministic for a seed', async () => {
    const a = await runSimulation({ seed: 7, steps: 80 });
    const b = await runSimulation({ seed: 7, steps: 80 });
    expect(a.server.log.map((e) => (e.op as { id: string }).id)).toEqual(
      b.server.log.map((e) => (e.op as { id: string }).id),
    );
  });
});

// TEMPORARY calibration harness (deleted after use): prints estimate vs measured time per family.
import { writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { renderBudget } from './markdownBudget';
import { renderMarkdown } from './markdownRender';
import { FAMILIES } from './zzfamilies.tmp';

describe('probe', () => {
  it('families at the cap', () => {
    const n = Number(process.env.PROBE_N ?? 100_000);
    const rows: string[] = [];
    const warm =
      '# t\n\n*a* **b** [l](http://x) `c`\n\n- a\n- b\n\n> q\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    for (let i = 0; i < 3; i++) renderMarkdown(warm.repeat(40));
    for (const [name, make] of Object.entries(FAMILIES as Record<string, (n: number) => string>)) {
      const src = make(n);
      let t0 = performance.now();
      const raw = renderBudget(src);
      const rawMs = performance.now() - t0;
      t0 = performance.now();
      const el = renderMarkdown(src);
      const ms = performance.now() - t0;
      const pre = el.querySelector('pre.md-fallback') as HTMLElement | null;
      rows.push(
        [
          name.padEnd(22),
          pre ? `FALLBACK(${pre.dataset.reason})`.padEnd(24) : 'rendered'.padEnd(24),
          `raw ${raw.ok ? raw.micros.toFixed(0) : raw.reason}`.padEnd(18),
          `gate+render ${ms.toFixed(0)} ms`.padEnd(24),
          `rawgate ${rawMs.toFixed(1)} ms`,
        ].join(' '),
      );
    }
    writeFileSync(
      process.env.PROBE_OUT ??
        'C:/Users/Admin/AppData/Local/Temp/claude/D--Projects-StudyVault-AI/eb08ca0d-139f-4090-aa25-4e7647f05278/scratchpad/md-probe/gate-100k.txt',
      rows.join('\n') + '\n',
    );
  }, 600_000);
});

// TEMPORARY: realistic documents through the gate (deleted after use)
import { writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { inlineBudget, renderBudget, runMicros } from './markdownBudget';
import { maskMath } from './markdownMath';
import { renderMarkdown, renderMarkdownUnbounded } from './markdownRender';
import { realisticNote } from './zzreal.tmp';

describe('real', () => {
  it('realistic notes', () => {
    const rows: string[] = [];
    for (let i = 0; i < 3; i++) renderMarkdown(realisticNote(5000));
    for (const size of [2_000, 5_000, 20_000, 50_000, 100_000]) {
      const src = realisticNote(size);
      const raw = renderBudget(src);
      let t0 = performance.now();
      const el = renderMarkdown(src);
      const ms = performance.now() - t0;
      t0 = performance.now();
      renderMarkdownUnbounded(src);
      const ref = performance.now() - t0;
      const pre = el.querySelector('pre.md-fallback') as HTMLElement | null;
      const lines = src.split('\n').filter((l) => l.trim() !== '').length;
      rows.push(
        `${size} chars ${lines} lines: raw ${raw.ok ? raw.micros.toFixed(0) : raw.reason} ${pre ? 'FALLBACK ' + pre.dataset.reason : 'rendered'} bounded ${ms.toFixed(0)} ms unbounded ${ref.toFixed(0)} ms`,
      );
    }
    void inlineBudget;
    void runMicros;
    void maskMath;
    writeFileSync(
      'C:/Users/Admin/AppData/Local/Temp/claude/D--Projects-StudyVault-AI/eb08ca0d-139f-4090-aa25-4e7647f05278/scratchpad/md-probe/real.txt',
      rows.join('\n') + '\n',
    );
  }, 120_000);
});

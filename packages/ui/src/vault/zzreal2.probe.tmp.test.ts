// TEMPORARY (deleted after use)
import { writeFileSync } from 'node:fs';
import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { describe, it } from 'vitest';
import { mathExtension } from './markdownMath';
import { realisticNote } from './zzreal.tmp';

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
describe('stages', () => {
  it('real: marked vs sanitise', () => {
    const marked = new Marked({ gfm: true, async: false, ...mathExtension(esc), renderer: { html: (t) => esc(t.text), image: (t) => esc(t.text) } });
    const purify = DOMPurify(window);
    const rows: string[] = [];
    for (const size of [20_000, 100_000]) {
      const src = realisticNote(size);
      for (let rep = 0; rep < 3; rep++) {
        let t0 = performance.now();
        const html = marked.parse(src) as string;
        const m = performance.now() - t0;
        t0 = performance.now();
        const frag = purify.sanitize(html, { RETURN_DOM_FRAGMENT: true });
        const s = performance.now() - t0;
        t0 = performance.now();
        const d = document.createElement('div');
        d.innerHTML = html;
        const i = performance.now() - t0;
        const count = d.querySelectorAll('*').length;
        rows.push(`${size} rep${rep} html ${html.length} elements ${count} marked ${m.toFixed(0)} sanitise ${s.toFixed(0)} innerHTML ${i.toFixed(0)} ${frag.childNodes.length}`);
      }
    }
    writeFileSync('C:/Users/Admin/AppData/Local/Temp/claude/D--Projects-StudyVault-AI/eb08ca0d-139f-4090-aa25-4e7647f05278/scratchpad/md-probe/real2.txt', rows.join('\n') + '\n');
  }, 120_000);
});

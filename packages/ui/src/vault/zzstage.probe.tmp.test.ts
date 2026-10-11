// TEMPORARY: where does the time go for output-heavy accepted inputs? (deleted after use)
import { writeFileSync } from 'node:fs';
import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { describe, it } from 'vitest';
import { mathExtension } from './markdownMath';
import { FAMILIES } from './zzfamilies.tmp';

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
describe('stages', () => {
  it('marked vs sanitise vs innerHTML', () => {
    const marked = new Marked({
      gfm: true,
      async: false,
      ...mathExtension(esc),
      renderer: { html: (t) => esc(t.text), image: (t) => esc(t.text) },
    });
    const purify = DOMPurify(window);
    const rows: string[] = [];
    for (const name of ['lt-a-attr', 'amp', 'amp-word', 'lt-bang', 'long-line-words', 'url-like', 'lt', 'table-pipes']) {
      const src = (FAMILIES as Record<string, (n: number) => string>)[name]!(100_000).slice(0, 100_000);
      for (let rep = 0; rep < 2; rep++) {
        let t0 = performance.now();
        const html = marked.parse(src) as string;
        const m = performance.now() - t0;
        t0 = performance.now();
        const frag = purify.sanitize(html, { RETURN_DOM_FRAGMENT: true, ALLOWED_TAGS: ['p', 'a', 'code'] });
        const s = performance.now() - t0;
        t0 = performance.now();
        const holder = document.createElement('div');
        holder.append(frag);
        const h = holder.innerHTML.length;
        const o = performance.now() - t0;
        t0 = performance.now();
        const d = document.createElement('div');
        d.innerHTML = html;
        const i = performance.now() - t0;
        rows.push(`${name.padEnd(18)} rep${rep} html ${html.length} marked ${m.toFixed(0)} sanitise ${s.toFixed(0)} serialise ${o.toFixed(0)} (${h}) innerHTML ${i.toFixed(0)}`);
      }
    }
    writeFileSync(
      'C:/Users/Admin/AppData/Local/Temp/claude/D--Projects-StudyVault-AI/eb08ca0d-139f-4090-aa25-4e7647f05278/scratchpad/md-probe/stage.txt',
      rows.join('\n') + '\n',
    );
  }, 120_000);
});

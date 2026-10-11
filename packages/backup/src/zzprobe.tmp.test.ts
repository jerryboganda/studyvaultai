// TEMPORARY probe (deleted after use): hostile text through the importers. Report-only.
import { writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { importCsvHighlights, importMarkdownHighlights } from './importExternal';
import { importAnkiHighlights, importDocument } from './importDocs';

const OUT =
  'C:/Users/Admin/AppData/Local/Temp/claude/D--Projects-StudyVault-AI/eb08ca0d-139f-4090-aa25-4e7647f05278/scratchpad/md-probe/import-probe.txt';
const rows: string[] = [];
const fill = (u: string, n: number) => u.repeat(Math.ceil(n / u.length)).slice(0, n);
const enc = (s: string) => new TextEncoder().encode(s);

async function time(name: string, fn: () => Promise<unknown>) {
  const t0 = performance.now();
  let outcome = 'ok';
  try {
    await fn();
  } catch (e) {
    outcome = `throws ${(e as { code?: string }).code ?? (e as Error).name}`;
  }
  rows.push(`${name.padEnd(62)} ${(performance.now() - t0).toFixed(0).padStart(7)} ms  ${outcome}`);
}

describe('import probe', () => {
  it('runs', async () => {
    const M = (s: string) => importMarkdownHighlights(s);
    await time('md: 1 MB of "> a" lines (one quote block)', () => M(fill('> a\n', 1_000_000)));
    await time('md: 4 MB of "> a" lines', () => M(fill('> a\n', 4_000_000)));
    await time('md: 1,000 quotes with metadata blocks', () =>
      M(fill('> quote text\n\n— [Title](https://example.com) · captured 2026-01-01 · essential-fact\n\n#tag1 #tag2\n\n', 400_000)),
    );
    await time('md: 20,000 quotes (over the record limit)', () => M(fill('> q\n\n', 200_000)));
    await time('md: "# a" + 2,000,000 spaces + "b"', () => M(`# a${' '.repeat(2_000_000)}b\n> q`));
    await time('md: 5 MB single line of "["', () => M(`> q\n\n— ${'['.repeat(4_000_000)}`));
    await time('md: 5 MB single line of "[a](" ', () => M(`> q\n\n— ${fill('[a](', 4_000_000)}`));
    await time('md: metadata line "#a " x 7,000 + "!"', () => M(`> q\n\n${fill('#a ', 21_000)}!`));
    await time('md: 4 MB of "#a #a" tag lines', () => M(`> q\n\n${fill('#a #a #a #a #a #a #a #a\n', 4_000_000)}`));
    await time('md: 4 MB of "\\\\*" escapes in one quote', () => M(`> ${fill('\\*', 4_000_000)}`));
    await time('md: 1 MB of blank lines then a quote', () => M(`${'\n'.repeat(1_000_000)}> q`));
    await time('md: 4 MB of headings "# a"', () => M(fill('# a\n', 4_000_000)));
    await time('md: front matter "---" x 4 MB', () => M(fill('---\n', 4_000_000)));
    await time('md: 2 MB of "> [!note] x" callouts', () => M(fill('> [!note] x\n\n', 2_000_000)));

    const C = (s: string) => importCsvHighlights(s);
    await time('csv: 4 MB of quotes', () => C(`quote\n${'"'.repeat(4_000_000)}`));
    await time('csv: 4 MB of ""', () => C(`quote\n"${fill('""', 4_000_000)}"`));
    await time('csv: 10,000 rows x 64 columns', () => C(`${fill('quote,', 64 * 6).slice(0, -1)}\n${fill(`${fill('a,', 64 * 2).slice(0, -1)}\n`, 10_000 * 129)}`));
    await time('csv: 1 first line of 4 MB (delimiter detection)', () => C(`quote${fill(',a', 4_000_000)}\nx`));
    await time('csv: 4 MB single field', () => C(`quote\n${'a'.repeat(4_000_000)}`));
    await time('csv: many short rows (10,000 + 1)', () => C(`quote\n${fill('a\n', 25_000)}`));

    const A = (s: string) => importAnkiHighlights(s);
    await time('anki: field of "[sound:" x 14,000 (no "]")', () =>
      A(`#separator:tab\n#html:false\nfront\t${fill('[sound:', 98_000)}\n`),
    );
    await time('anki: 4 MB of notes', () => A(`#separator:tab\n#html:false\n${fill('a\tb\n', 4_000_000)}`));
    await time('anki: html field "<b>" x 20,000 nested (jsdom)', () =>
      A(`#separator:tab\n#html:true\nfront\t${'<b>'.repeat(20_000)}x\n`),
    );
    await time('anki: html field "<b>x</b>" x 20,000 siblings', () =>
      A(`#separator:tab\n#html:true\nfront\t${fill('<b>x</b>', 100_000)}\n`),
    );
    await time('anki: 2,000 html notes', () => A(`#separator:tab\n#html:true\n${fill('<b>front</b>\t<i>back</i>\n', 90_000)}`));
    await time('anki: "{{c1::" cloze x 10,000', () => A(`#separator:tab\n#html:false\n${fill('{{c1::a}} ', 90_000)}\n`));

    const D = (name: string, text: string) =>
      importDocument({ name, bytes: enc(text) }).then(() => undefined);
    await time('html: 5,000 nested <span> (jsdom: no depth cap)', () => D('a.html', `<body>${'<span>'.repeat(5_000)}x`));
    await time('html: 20,000 <p> paragraphs', () => D('a.html', `<body>${fill('<p>a</p>', 140_000)}`));
    await time('html: 3 MB of text in one paragraph', () => D('a.html', `<body><p>${'a'.repeat(3_000_000)}`));
    await time('html: 100,000 "<" in text', () => D('a.html', `<body><p>${'<'.repeat(100_000)}`));
    await time('html: 20,000 <br>', () => D('a.html', `<body><p>${fill('a<br>', 100_000)}`));
    await time('html: table 200x200', () =>
      D('a.html', `<body><table>${fill(`<tr>${fill('<td>a</td>', 1_000)}</tr>`, 200_000)}</table>`),
    );
  }, 600_000);

  it('writes', () => {
    writeFileSync(OUT, rows.join('\n') + '\n');
  });
});

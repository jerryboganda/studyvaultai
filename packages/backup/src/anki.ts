import { csvCell } from './csv';
import { cleanText, safeHttpUrl, str, strOrNull } from './text';
import {
  locationLabel,
  type ExportDataset,
  type HighlightView,
  buildHighlightViews,
} from './views';
import type { Row } from './types';

export interface AnkiOptions {
  /** 'tsv' (default, tab separated) or 'csv' (comma separated). */
  format?: 'tsv' | 'csv';
  /**
   * Where the citation goes. 'back' (default) appends it to the Back / Back Extra field, so the file
   * imports into Anki's built-in "Basic" and "Cloze" note types as is. 'field' writes a separate
   * Source column for note types named "StudyVault Basic" (Front, Back, Source) and
   * "StudyVault Cloze" (Text, Back Extra, Source) that you create in Anki first.
   */
  sourcePlacement?: 'back' | 'field';
  /** Include cards the user suspended. Default false: importing would make them active in Anki. */
  includeSuspended?: boolean;
  includeDeleted?: boolean;
  /** Deck for cards whose deck is unknown. Default "StudyVault". */
  defaultDeck?: string;
  /** Spreadsheet formula guard (leading apostrophe). Default true. */
  formulaGuard?: boolean;
}

export interface AnkiColumn {
  /** 1-based, as Anki's `#... column:N` headers count. */
  index: number;
  name: 'GUID' | 'Note type' | 'Deck' | 'Front' | 'Back' | 'Source' | 'Tags';
  /** What the column feeds in Anki. */
  maps: string;
}

export interface AnkiExport {
  filename: string;
  content: string;
  separator: 'tab' | 'Comma';
  /** The explicit mapping, for display next to the download. */
  columns: AnkiColumn[];
  noteTypes: { name: string; fields: string[]; notes: number }[];
  noteCount: number;
  /** Cards not exported, with the reason (suspended, unsupported ...). */
  skipped: { id: string; reason: string }[];
  /** What to tell the user before they import. */
  instructions: string[];
}

const escapeHtml = (s: string): string =>
  cleanText(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '    ')
    .replace(/\n/g, '<br>');

// ---------------------------------------------------------------------------------------------
// Cloze mapping. StudyVault cloze markup is Anki's ({{c1::answer::hint}}, nesting allowed), but a
// StudyVault card tests ONE deletion (`activeIndex`) and shows the others as context, whereas Anki
// makes one card per index. So each card becomes its own note in which the tested deletion is c1
// and the others are plain text. `activeIndex === null` ("hide all at once") makes all of them c1.
// ---------------------------------------------------------------------------------------------

interface ClozeNode {
  index: number;
  kids: (string | ClozeNode)[];
  hint: string | null;
}

function parseClozeMarkup(src: string): (string | ClozeNode)[] {
  const root: (string | ClozeNode)[] = [];
  const stack: { node: ClozeNode; open: string; inHint: boolean }[] = [];
  let buf = '';
  const sink = () => stack[stack.length - 1]?.node.kids ?? root;
  const flush = () => {
    if (buf) sink().push(buf);
    buf = '';
  };
  const unwind = () => {
    // unclosed deletions degrade to the literal text they were typed as
    while (stack.length > 0) {
      flush();
      const f = stack.pop() as (typeof stack)[number];
      const parent = sink();
      parent.push(f.open, ...f.node.kids, ...(f.inHint ? ['::', f.node.hint ?? ''] : []));
    }
  };
  for (let i = 0; i < src.length;) {
    const top = stack[stack.length - 1];
    if (top?.inHint) {
      if (src.startsWith('}}', i)) {
        stack.pop();
        sink().push(top.node);
        i += 2;
      } else {
        top.node.hint = (top.node.hint ?? '') + src[i];
        i++;
      }
      continue;
    }
    if (src.startsWith('{{c', i) && stack.length < 6) {
      const m = /^\{\{c(\d{1,2})::/.exec(src.slice(i, i + 9));
      if (m) {
        flush();
        const open = m[0];
        stack.push({ node: { index: Number(m[1]), kids: [], hint: null }, open, inHint: false });
        i += open.length;
        continue;
      }
    }
    if (top && src.startsWith('::', i)) {
      flush();
      top.inHint = true;
      top.node.hint = '';
      i += 2;
      continue;
    }
    if (top && src.startsWith('}}', i)) {
      flush();
      stack.pop();
      sink().push(top.node);
      i += 2;
      continue;
    }
    buf += src[i];
    i++;
  }
  flush();
  unwind();
  return root;
}

export function toAnkiCloze(markup: string, activeIndex: number | null): string {
  const render = (nodes: (string | ClozeNode)[], inside: boolean): string =>
    nodes
      .map((n) => {
        if (typeof n === 'string') return n;
        const active = activeIndex === null || n.index === activeIndex;
        const inner = render(n.kids, inside || active);
        if (!active || inside) return inner;
        return `{{c1::${inner}${n.hint ? `::${n.hint}` : ''}}}`;
      })
      .join('');
  return render(parseClozeMarkup(markup), false);
}

/** The sentence a cloze note reads as: every deletion filled in, hints dropped (Anki import). */
export function clozeToText(markup: string): string {
  const flat = (nodes: (string | ClozeNode)[]): string =>
    nodes.map((n) => (typeof n === 'string' ? n : flat(n.kids))).join('');
  return flat(parseClozeMarkup(markup));
}

// ---------------------------------------------------------------------------------------------

const sanitizeTag = (t: string): string =>
  cleanText(t).trim().replace(/\s+/g, '_').replace(/["]/g, '');
const sanitizeDeck = (d: string): string =>
  cleanText(d).replace(/"/g, "'").replace(/\s+/g, ' ').trim();

function sourceHtml(v: HighlightView | undefined, fallbackQuote: string | null): string | null {
  if (!v) return fallbackQuote ? `<small>Source quote: ${escapeHtml(fallbackQuote)}</small>` : null;
  const title = escapeHtml(v.sourceTitle);
  const url = safeHttpUrl(v.sourceUrl);
  const link = url ? `<a href="${escapeHtml(url)}">${title}</a>` : title;
  const loc = locationLabel(v);
  return `<small>Source: ${link}${loc ? ` · ${escapeHtml(loc)}` : ''}</small>`;
}

/**
 * Anki-importable text file from study cards (`cards`, with `decks`; highlights/sources supply the
 * citation). Columns: GUID, Note type, Deck, Front|Text, Back|Back Extra, [Source], Tags, mapped
 * with Anki's file-header directives. GUIDs are `sv-<card id>`, so re-importing updates the same
 * notes instead of duplicating them. Scheduling (FSRS state, due dates) is not carried over.
 */
export function exportAnki(data: ExportDataset, options: AnkiOptions = {}): AnkiExport {
  const sep = options.format === 'csv' ? ',' : '\t';
  const sepName = options.format === 'csv' ? 'Comma' : 'tab';
  const field = options.sourcePlacement === 'field';
  const guard = options.formulaGuard !== false;
  const defaultDeck = sanitizeDeck(options.defaultDeck ?? 'StudyVault') || 'StudyVault';

  const views = new Map(buildHighlightViews(data, { includeDeleted: true }).map((v) => [v.id, v]));
  const decks = new Map((data.decks ?? []).map((d) => [str(d.id), d]));
  const skipped: AnkiExport['skipped'] = [];
  const types = new Map<string, { name: string; fields: string[]; notes: number }>();

  const rows: string[][] = [];
  const cards = [...(data.cards ?? [])].sort((a, b) => (str(a.id) < str(b.id) ? -1 : 1));
  for (const c of cards) {
    const id = str(c.id);
    if (c.deletedAt != null && options.includeDeleted !== true) continue;
    if (c.suspended === true && options.includeSuspended !== true) {
      skipped.push({ id, reason: 'suspended' });
      continue;
    }
    const cardType = str(c.cardType) || 'basic';
    const view = typeof c.highlightId === 'string' ? views.get(c.highlightId) : undefined;
    const src = sourceHtml(view, strOrNull(c.sourceQuote));
    const deckRow = decks.get(str(c.deckId)) as Row | undefined;
    const deck = sanitizeDeck(str(deckRow?.name)) || defaultDeck;
    const tags = (Array.isArray(c.tags) ? c.tags : [])
      .map((t) => sanitizeTag(String(t)))
      .filter(Boolean)
      .join(' ');

    let noteType: string;
    let f1: string;
    let f2: string;
    if (cardType === 'cloze') {
      const cloze = (c.cloze ?? null) as Row | null;
      const markup = typeof cloze?.text === 'string' ? cloze.text : '';
      if (!markup.includes('{{c')) {
        skipped.push({ id, reason: 'cloze card without cloze markup' });
        continue;
      }
      const active = typeof cloze?.activeIndex === 'number' ? cloze.activeIndex : null;
      noteType = field ? 'StudyVault Cloze' : 'Cloze';
      f1 = escapeHtml(toAnkiCloze(markup, active));
      f2 = [escapeHtml(str(c.back)), c.explanation ? escapeHtml(str(c.explanation)) : '']
        .filter(Boolean)
        .join('<br><br>');
    } else {
      noteType = field ? 'StudyVault Basic' : 'Basic';
      if (cardType === 'mcq' && Array.isArray(c.choices)) {
        const choices = c.choices as Row[];
        const letter = (i: number) => String.fromCharCode(65 + i);
        f1 = [
          escapeHtml(str(c.front)),
          ...choices.map((ch, i) => `${letter(i)}. ${escapeHtml(str(ch.text))}`),
        ].join('<br>');
        const at = choices.findIndex((ch) => ch.id === c.answerChoiceId);
        const answer =
          at >= 0
            ? `${letter(at)}. ${escapeHtml(str(choices[at]?.text))}`
            : escapeHtml(str(c.back));
        f2 = [answer, c.explanation ? escapeHtml(str(c.explanation)) : '']
          .filter(Boolean)
          .join('<br><br>');
      } else {
        f1 = escapeHtml(str(c.front));
        f2 = escapeHtml(str(c.back));
      }
    }
    if (f1.trim() === '') {
      skipped.push({ id, reason: 'empty front' });
      continue;
    }
    const row = [`sv-${id}`, noteType, deck, f1];
    if (field) row.push(f2, src ?? '');
    else row.push(src ? `${f2}${f2 ? '<br><br>' : ''}${src}` : f2);
    row.push(tags);
    rows.push(row);

    const names = noteType.endsWith('Cloze') ? ['Text', 'Back Extra'] : ['Front', 'Back'];
    const entry = types.get(noteType) ?? {
      name: noteType,
      fields: field ? [...names, 'Source'] : names,
      notes: 0,
    };
    entry.notes++;
    types.set(noteType, entry);
  }

  const columns: AnkiColumn[] = [
    { index: 1, name: 'GUID', maps: 'Note GUID (stable per card; re-import updates)' },
    { index: 2, name: 'Note type', maps: 'Note type' },
    { index: 3, name: 'Deck', maps: 'Deck' },
    { index: 4, name: 'Front', maps: 'Front (Basic) / Text (Cloze)' },
    {
      index: 5,
      name: 'Back',
      maps: field
        ? 'Back (Basic) / Back Extra (Cloze)'
        : 'Back (Basic) / Back Extra (Cloze), citation appended',
    },
  ];
  if (field) columns.push({ index: 6, name: 'Source', maps: 'Source field (custom note types)' });
  columns.push({ index: columns.length + 1, name: 'Tags', maps: 'Tags' });
  const tagsColumn = columns.length;

  const header = [
    `#separator:${sepName}`,
    '#html:true',
    '#guid column:1',
    '#notetype column:2',
    '#deck column:3',
    `#tags column:${tagsColumn}`,
  ];
  const body = rows.map((r) =>
    r.map((c) => csvCell(c, { delimiter: sep, formulaGuard: guard })).join(sep),
  );
  const content = `${[...header, ...body].join('\n')}\n`;

  const instructions = [
    'In Anki choose File > Import and pick the file; the header lines select separator, HTML, GUID, note type, deck and tags columns.',
    field
      ? 'Create the note types "StudyVault Basic" (fields Front, Back, Source) and "StudyVault Cloze" (a Cloze type with fields Text, Back Extra, Source) first.'
      : 'The citation is appended to the Back / Back Extra field so the built-in Basic and Cloze note types can be used unchanged.',
    'Each StudyVault cloze card becomes its own Cloze note testing one deletion; other deletions appear as plain text.',
    'Review scheduling (due dates, FSRS state) is not exported: imported notes start as new cards.',
    'Anki .apkg packages are not produced; use this text import.',
  ];

  return {
    filename:
      options.format === 'csv' ? 'studyvault-anki-import.csv' : 'studyvault-anki-import.txt',
    content,
    separator: sepName,
    columns,
    noteTypes: [...types.values()],
    noteCount: rows.length,
    skipped,
    instructions,
  };
}

import { safeFilename, uniquePaths } from './filenames';
import { cleanText, isoDay } from './text';
import {
  UNFILED,
  buildHighlightViews,
  locationLabel,
  type ExportDataset,
  type HighlightView,
  type Membership,
} from './views';

export interface ExportFile {
  /** Relative path with "/" separators; every segment passes safeFilename. */
  path: string;
  content: string;
}

export interface MarkdownOptions {
  /**
   * 'per-bank' (default): one file per bank, folders as headings.
   * 'per-folder': `Bank/Folder/Sub.md`, one file per folder that holds highlights.
   * 'single': one combined file.
   */
  layout?: 'single' | 'per-bank' | 'per-folder';
  /** Obsidian dialect: wiki links between files, block ids, an index note, `tags` front matter. */
  obsidian?: boolean;
  /** YAML front matter on every file. Default true. */
  frontMatter?: boolean;
  /** Include the user's notes under each highlight. Default true. */
  includeNotes?: boolean;
  /** Include soft-deleted highlights. Default false. */
  includeDeleted?: boolean;
  /** Written to front matter; inject for reproducible output. Default now. */
  exportedAt?: Date;
}

// ---------------------------------------------------------------------------------------------
// Escaping: page text is untrusted, so it must not be able to add links, embeds, HTML, comments,
// math or headings to the user's notes. Rendered output shows the exact characters.
// ---------------------------------------------------------------------------------------------

export function escapeMarkdown(text: string): string {
  return cleanText(text)
    .replace(/([\\`*_[\]<>~|&$])/g, '\\$1')
    .replace(/==/g, '\\=\\=')
    .replace(/%%/g, '\\%\\%');
}

/** Escapes a line that will sit inside a block (quote, paragraph): inline escapes + block markers. */
function escapeLine(line: string): string {
  const e = escapeMarkdown(line);
  // block markers at the start of a line: ATX heading, bullet, ordered list, setext underline, fence
  return e.replace(
    /^(\s{0,3})(#{1,6}(?=\s|$)|[-+](?=\s|$)|\d{1,9}[.)](?=\s|$)|=+\s*$|-+\s*$|:{3,})/,
    '$1\\$2',
  );
}

const blockquote = (text: string): string =>
  cleanText(text)
    .split('\n')
    .map((l) => `> ${escapeLine(l)}`.trimEnd())
    .join('\n');

/** `#tag` safe for Markdown/Obsidian: letters, digits, `_`, `-`, `/`; never purely numeric. */
export function markdownTag(name: string): string | null {
  const t = name
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_\-/]/gu, '')
    .replace(/^[-/]+|[-/]+$/g, '');
  if (t.length === 0) return null;
  return /^\d+$/.test(t) ? `t${t}` : t;
}

/** Link destination: http(s) only (views already filter); parentheses would end the link early. */
const linkTarget = (url: string): string => url.replace(/\(/g, '%28').replace(/\)/g, '%29');

const blockId = (id: string): string => `sv-${id.replace(/[^0-9A-Za-z-]/g, '-')}`;

const yamlString = (s: string): string => JSON.stringify(cleanText(s).replace(/\n/g, ' '));

function frontMatter(fields: Record<string, string | number | string[]>): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    lines.push(
      Array.isArray(v)
        ? `${k}: [${v.map(yamlString).join(', ')}]`
        : typeof v === 'number'
          ? `${k}: ${v}`
          : `${k}: ${yamlString(v)}`,
    );
  }
  lines.push('---', '');
  return lines.join('\n');
}

interface Render {
  obsidian: boolean;
  includeNotes: boolean;
  /** Other placements of the same highlight, as link text, for the "Also in" line. */
  alsoIn: (v: HighlightView, here: Membership | null) => string | null;
}

function renderHighlight(v: HighlightView, here: Membership | null, r: Render): string {
  // Paragraphs, separated by blank lines: renderers differ on soft line breaks, blank lines do not.
  const out: string[] = [blockquote(v.quote)];
  // Obsidian block id: on its own paragraph right after the quote, so [[file#^id]] points at the quote.
  if (r.obsidian) out.push(`^${blockId(v.id)}`);

  const cite: string[] = [];
  const title = escapeMarkdown(v.sourceTitle);
  cite.push(
    v.sourceUrl
      ? `— [${title}](${linkTarget(v.sourceUrl)})`
      : `— ${title}${v.sourceType === 'pdf' ? ' (PDF)' : ''}`,
  );
  const day = isoDay(v.capturedAt);
  if (day) cite.push(`captured ${day}`);
  const loc = locationLabel(v);
  if (loc) cite.push(loc);
  if (v.heading) cite.push(`§ ${escapeMarkdown(v.heading)}`);
  if (v.kind) cite.push(escapeMarkdown(v.kind));
  if (v.priority !== null) cite.push(`priority ${v.priority}`);
  out.push(cite.join(' · '));

  const tags = v.tags.map(markdownTag).filter((t): t is string => t !== null);
  if (tags.length > 0) out.push(tags.map((t) => `#${t}`).join(' '));

  const also = r.alsoIn(v, here);
  if (also) out.push(`Also in: ${also}`);

  if (v.comment.trim() !== '') {
    const lines = cleanText(v.comment).split('\n').map(escapeLine);
    out.push(`**Comment:** ${lines.join('\n')}`);
  }
  if (r.includeNotes) {
    for (const n of v.notes) {
      // The note is the user's own Markdown: kept as written, under a bold label.
      const label = n.title.trim() ? `**Note:** ${escapeMarkdown(n.title)}` : '**Note:**';
      out.push(label, cleanText(n.body).trimEnd());
    }
  }
  return out.join('\n\n');
}

interface Placement {
  view: HighlightView;
  membership: Membership;
}

interface BankGroup {
  bankId: string;
  bankName: string;
  position: number;
  placements: Placement[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Markdown export. Quotes are blockquotes, each followed by a citation line
 * (`— [title](url) · captured YYYY-MM-DD · page/offset · § heading · kind · priority`), then #tags,
 * the user's comment and notes. Returns files; zip them with fflate or save them one by one.
 */
export function exportMarkdown(data: ExportDataset, options: MarkdownOptions = {}): ExportFile[] {
  const layout = options.layout ?? 'per-bank';
  const obsidian = options.obsidian === true;
  const withFrontMatter = options.frontMatter !== false;
  const exportedAt = (options.exportedAt ?? new Date()).toISOString();
  const views = buildHighlightViews(data, { includeDeleted: options.includeDeleted === true });

  // bank -> placements
  const groups = new Map<string, BankGroup>();
  const bankPos = new Map<string, number>();
  for (const b of data.banks) {
    if (b.deletedAt != null && options.includeDeleted !== true) continue;
    const id = String(b.id);
    bankPos.set(id, typeof b.position === 'number' ? b.position : 0);
    groups.set(id, {
      bankId: id,
      bankName: String(b.name ?? ''),
      position: typeof b.position === 'number' ? b.position : 0,
      placements: [],
    });
  }
  for (const v of views) {
    const ms: Membership[] =
      v.memberships.length > 0
        ? v.memberships
        : [{ bankId: '', bankName: UNFILED, folderPath: [], folderId: null }];
    for (const m of ms) {
      let g = groups.get(m.bankId || '__unfiled__');
      if (!g) {
        g = {
          bankId: m.bankId || '__unfiled__',
          bankName: m.bankName,
          position: Number.MAX_SAFE_INTEGER,
          placements: [],
        };
        groups.set(g.bankId, g);
      }
      g.placements.push({ view: v, membership: m });
    }
  }
  const banks = [...groups.values()]
    .filter((g) => g.bankId !== '__unfiled__' || g.placements.length > 0)
    .sort((a, b) => a.position - b.position || cmp(a.bankName, b.bankName));

  // Unique, filesystem-safe base names per output file (decided up front so links can use them).
  const pathOf = new Map<string, string>(); // `${bankId}\u0000${folderPath.join('\u0001')}` -> path without .md
  const key = (bankId: string, folder: readonly string[]) =>
    `${bankId}\u0000${folder.join('\u0001')}`;
  const ext = '.md';

  let files: { path: string; build: () => string }[] = [];
  const header = (title: string, extra: Record<string, string | number | string[]>): string =>
    withFrontMatter
      ? frontMatter({
          title,
          type: 'studyvault-export',
          exported: exportedAt,
          ...extra,
          ...(obsidian ? { tags: ['studyvault'] } : {}),
        })
      : '';

  const alsoIn = (v: HighlightView, here: Membership | null): string | null => {
    const others = v.memberships.filter(
      (m) =>
        !here || m.bankId !== here.bankId || key('', m.folderPath) !== key('', here.folderPath),
    );
    if (others.length === 0) return null;
    return others
      .map((m) => {
        const raw = [m.bankName, ...m.folderPath].join(' / ');
        const target = pathOf.get(key(m.bankId, layout === 'per-folder' ? m.folderPath : []));
        if (obsidian && target && layout !== 'single') {
          // wiki-link syntax has no escapes: characters that would end the link are dropped
          const clean = target.replace(/[[\]|#^]/g, '');
          return `[[${clean}|${cleanText(raw).replace(/[[\]|#^\n]/g, '')}]]`;
        }
        return escapeMarkdown(raw);
      })
      .join(', ');
  };
  const render: Render = { obsidian, includeNotes: options.includeNotes !== false, alsoIn };

  const bankSection = (g: BankGroup, level: number): string[] => {
    const out: string[] = [];
    const rootItems = g.placements.filter((p) => p.membership.folderPath.length === 0);
    for (const p of rootItems) out.push(renderHighlight(p.view, p.membership, render), '');
    const withFolders = g.placements.filter((p) => p.membership.folderPath.length > 0);
    const emitted = new Set<string>();
    const sorted = [...withFolders].sort((a, b) =>
      cmp(a.membership.folderPath.join('\u0001'), b.membership.folderPath.join('\u0001')),
    );
    for (const p of sorted) {
      const path = p.membership.folderPath;
      for (let d = 1; d <= path.length; d++) {
        const k = path.slice(0, d).join('\u0001');
        if (emitted.has(k)) continue;
        emitted.add(k);
        out.push(`${'#'.repeat(Math.min(6, level + d))} ${escapeMarkdown(path[d - 1] ?? '')}`, '');
      }
      out.push(renderHighlight(p.view, p.membership, render), '');
    }
    return out;
  };

  const count = (n: number) => `${n} highlight${n === 1 ? '' : 's'}`;

  if (layout === 'single') {
    const total = new Set(views.map((v) => v.id)).size;
    files = [
      {
        path: 'StudyVault export.md',
        build: () => {
          const out: string[] = [
            header('StudyVault export', { highlights: total }),
            '# StudyVault export',
            '',
          ];
          if (banks.length === 0) out.push('_No highlights._', '');
          for (const g of banks) {
            out.push(`## ${escapeMarkdown(g.bankName)}`, '');
            if (g.placements.length === 0) out.push('_No highlights._', '');
            out.push(...bankSection(g, 2));
          }
          return `${out.join('\n').trimEnd()}\n`;
        },
      },
    ];
  } else if (layout === 'per-bank') {
    const names = uniquePaths(
      banks.map((g) => `${safeFilename(g.bankName, { fallback: 'bank' })}${ext}`),
    );
    banks.forEach((g, i) => {
      const p = names[i] as string;
      pathOf.set(key(g.bankId, []), p.slice(0, -ext.length));
      files.push({
        path: p,
        build: () => {
          const ids = new Set(g.placements.map((x) => x.view.id));
          const out: string[] = [
            header(g.bankName, { bank: g.bankName, highlights: ids.size }),
            `# ${escapeMarkdown(g.bankName)}`,
            '',
          ];
          if (g.placements.length === 0) out.push('_No highlights._', '');
          out.push(...bankSection(g, 1));
          return `${out.join('\n').trimEnd()}\n`;
        },
      });
    });
  } else {
    // per-folder: Bank/Folder/Sub.md ; highlights directly in a bank go to Bank/_No folder.md
    const raw: { bank: BankGroup; folder: string[]; items: Placement[] }[] = [];
    for (const g of banks) {
      const byFolder = new Map<string, { folder: string[]; items: Placement[] }>();
      for (const p of g.placements) {
        const k = p.membership.folderPath.join('\u0001');
        const e = byFolder.get(k) ?? { folder: p.membership.folderPath, items: [] };
        e.items.push(p);
        byFolder.set(k, e);
      }
      if (byFolder.size === 0) byFolder.set('', { folder: [], items: [] });
      for (const e of [...byFolder.values()].sort((a, b) =>
        cmp(a.folder.join('\u0001'), b.folder.join('\u0001')),
      )) {
        raw.push({ bank: g, folder: e.folder, items: e.items });
      }
    }
    const paths = uniquePaths(
      raw.map((r) => {
        const dir = safeFilename(r.bank.bankName, { fallback: 'bank' });
        if (r.folder.length === 0) return `${dir}/_No folder${ext}`;
        const segs = r.folder.map((f) => safeFilename(f, { fallback: 'folder' }));
        return `${dir}/${segs.join('/')}${ext}`;
      }),
    );
    raw.forEach((r, i) => {
      const p = paths[i] as string;
      pathOf.set(key(r.bank.bankId, r.folder), p.slice(0, -ext.length));
      files.push({
        path: p,
        build: () => {
          const title = [r.bank.bankName, ...r.folder].join(' / ');
          const out: string[] = [
            header(title, {
              bank: r.bank.bankName,
              ...(r.folder.length ? { folder: r.folder.join(' / ') } : {}),
              highlights: new Set(r.items.map((x) => x.view.id)).size,
            }),
            `# ${escapeMarkdown(title)}`,
            '',
          ];
          if (r.items.length === 0) out.push('_No highlights._', '');
          for (const it of r.items) out.push(renderHighlight(it.view, it.membership, render), '');
          return `${out.join('\n').trimEnd()}\n`;
        },
      });
    });
  }

  const result: ExportFile[] = files.map((f) => ({ path: f.path, content: f.build() }));
  if (obsidian && layout !== 'single') {
    const lines = result.map((f) => {
      const n = new Set(f.content.match(/\^sv-[0-9A-Za-z-]+/g) ?? []).size;
      return `- [[${f.path.slice(0, -ext.length).replace(/[[\]|#^]/g, '')}]] (${count(n)})`;
    });
    const index = `${header('StudyVault Index', { files: result.length })}\n# StudyVault Index\n\n${lines.join('\n')}\n`;
    result.unshift({
      path: uniquePaths([...result.map((f) => f.path), 'StudyVault Index.md']).at(-1) as string,
      content: index,
    });
  }
  return result;
}

import { DEFAULT_PALETTE, type HighlightKind, type ResolveStatus } from '@shared';
import {
  addToBank,
  attachTags,
  cacheDocumentBytes,
  createBank,
  createCardsFromHighlight,
  createFilingRule,
  createFolder,
  createKnowledgePoint,
  createManualCards,
  createNote,
  createRelation,
  createSyllabus,
  createTag,
  deleteFolder,
  deleteNote,
  reportResolutions,
  reviewCard,
  savePdfHighlight,
  setBankColor,
  setBankIcon,
  softDeleteHighlight,
  upsertDocument,
  withWritableDb,
} from '@storage';
import { createSavedSearch, serializeSavedSearches, type SavedSearch } from '@search';
import { sha256Hex } from '@pdf/fingerprint';
import pdfUrl from '../../tests/fixtures/pdf/real/cdc-child-immunization-schedule-2025.pdf?url';
import {
  DAY,
  HOUR,
  MINUTE,
  NOW,
  ago,
  atTime,
  capture,
  completeOnboarding,
  grantSites,
  patchSettings,
  pickKind,
  pickPriority,
  rng,
  type Rng,
  type Scenario,
} from './kit';
import { BANKS, COMMENTS, INBOX_SOURCES, NOTES, type FolderSpec, type SourceSpec } from './medical';

interface Saved {
  id: string;
  quote: string;
  cloze: string;
  url: string;
  at: number;
  bankName: string | null;
  kind: HighlightKind;
}

async function createFolders(
  bankId: string,
  specs: readonly FolderSpec[],
  into: Map<string, string>,
  parent: { id: string | null; path: string } = { id: null, path: '' },
) {
  for (const spec of specs) {
    const folder = await createFolder({ bankId, name: spec.name, parentFolderId: parent.id });
    const path = parent.path ? `${parent.path}/${spec.name}` : spec.name;
    into.set(path, folder.id);
    if (spec.children) await createFolders(bankId, spec.children, into, { id: folder.id, path });
  }
}

/** Review a new card the way a student who studies most days would, up to `until`. */
async function reviewHistory(r: Rng, cardId: string, from: number, until: number) {
  let at = from + r.int(5, 40) * MINUTE;
  for (let i = 0; i < 14 && at <= until; i++) {
    const rating = r.weighted<1 | 2 | 3 | 4>([
      [1, 10],
      [2, 14],
      [3, 64],
      [4, 12],
    ]);
    const out = await reviewCard(cardId, rating, { now: at, durationMs: r.int(3, 25) * 1000 });
    if (out.status !== 'reviewed') return;
    // Answer the next time it is due, usually in that day's study block.
    at = Math.max(Date.parse(out.card.dueAt), at + MINUTE) + r.int(0, 6) * HOUR;
  }
}

export const student: Scenario = {
  id: 'student',
  title: 'Medical student, two months of highlights, cards and reviews',
  tab: 'article',
  async seed(ctx) {
    const r = rng(20261014);
    await completeOnboarding('medicine');

    // Banks, folders and tags: set up on the first day.
    const bankIds = new Map<string, string>();
    const folderIds = new Map<string, string>();
    const tagIds = new Map<string, string>();
    await atTime(ago(62 * DAY), async () => {
      for (const spec of BANKS) {
        const bank = await createBank(spec.name);
        await setBankColor(bank.id, spec.color);
        await setBankIcon(bank.id, spec.icon);
        bankIds.set(spec.name, bank.id);
        const folders = new Map<string, string>();
        await createFolders(bank.id, spec.folders, folders);
        for (const [path, id] of folders) folderIds.set(`${spec.name}/${path}`, id);
      }
      const names = new Set([...BANKS.flatMap((b) => b.tags), 'mnemonic', 'exam-trap', 'step-1']);
      for (const name of names) tagIds.set(name, (await createTag(name)).tag.id);
    });

    // Reading sessions: one source per sitting, spread over the last eight weeks. The article in
    // the active tab is the most recent one, read the day before yesterday.
    type Session = { source: SourceSpec; bankName: string | null; tags: readonly string[] };
    const sessions: Session[] = [
      ...BANKS.flatMap((b) =>
        b.sources.map((source) => ({ source, bankName: b.name, tags: b.tags })),
      ),
      ...INBOX_SOURCES.map((source) => ({ source, bankName: null, tags: [] as string[] })),
    ];
    const article = sessions.findIndex((s) => s.source.url.endsWith('/Beta_blocker'));
    const ordered = [...sessions.filter((_, i) => i !== article)].sort(() => r.next() - 0.5);
    ordered.push(sessions[article]!);

    const saved: Saved[] = [];
    for (const [i, session] of ordered.entries()) {
      const day = Math.round(58 - (i * 56) / (ordered.length - 1));
      let at = ago(day * DAY) - r.int(0, 10) * HOUR;
      const { source, bankName } = session;
      for (const [j, [quote, cloze]] of source.facts.entries()) {
        at += r.int(2, 9) * MINUTE;
        const kind: HighlightKind = quote.endsWith('?')
          ? 'question'
          : /equals|formula|=/.test(quote)
            ? 'formula'
            : pickKind(r);
        const bankId = bankName ? bankIds.get(bankName)! : null;
        const result = await capture({
          url: source.url,
          title: source.title,
          quote,
          at,
          heading: source.headings[j % source.headings.length],
          kind,
          bankId,
          comment: r.chance(0.28) ? r.pick(COMMENTS) : '',
          priority: pickPriority(r),
        });
        const id = result.highlight.id;
        if (bankId && source.folder) {
          const folderId = folderIds.get(`${bankName}/${source.folder}`)!;
          await atTime(at, () => addToBank({ highlightId: id, bankId, folderId }));
        }
        const tags = [
          ...(r.chance(0.5) && session.tags.length ? [r.pick(session.tags)] : []),
          ...(r.chance(0.12) ? [r.pick(['mnemonic', 'exam-trap', 'step-1'])] : []),
        ];
        if (tags.length) {
          const ids = [...new Set(tags.map((t) => tagIds.get(t)!))];
          await atTime(at, () => attachTags({ highlightIds: [id], tagIds: ids }));
        }
        saved.push({ id, quote, cloze, url: source.url, at, bankName, kind });
      }
    }
    const byQuote = (text: string) => saved.find((s) => s.quote.includes(text))!;

    // The same passage saved from a second page: two duplicate pairs.
    const duplicates = [
      {
        of: 'mask the adrenergic warning signs',
        url: 'https://www.ncbi.nlm.nih.gov/books/NBK532906/',
        title: 'Beta Blockers - StatPearls - NCBI Bookshelf',
        bank: 'Pharmacology',
      },
      {
        of: 'irregularly irregular rhythm',
        url: 'https://www.ncbi.nlm.nih.gov/books/NBK526072/',
        title: 'Atrial Fibrillation - StatPearls - NCBI Bookshelf',
        bank: 'Cardiology',
      },
    ];
    for (const d of duplicates) {
      const first = byQuote(d.of);
      await capture({
        url: d.url,
        title: d.title,
        quote: first.quote,
        at: first.at > ago(10 * DAY) ? first.at - 9 * DAY : first.at + 9 * DAY,
        kind: first.kind,
        bankId: bankIds.get(d.bank)!,
      });
    }

    // Study notes in Markdown.
    for (const note of NOTES) {
      const target = byQuote(note.match);
      await atTime(target.at + 30 * MINUTE, () =>
        createNote({ highlightId: target.id, body: note.body, pinned: note.pinned ?? false }),
      );
    }

    // Where the painted highlights were last found on their pages.
    const statuses: { id: string; status: ResolveStatus; confidence: number | null }[] = saved.map(
      (s) => ({ id: s.id, status: 'resolved', confidence: 1 }),
    );
    const articleRows = saved.filter((s) => s.url.endsWith('/Beta_blocker'));
    const mark = (id: string, status: ResolveStatus, confidence: number | null) => {
      const row = statuses.find((s) => s.id === id);
      if (row) Object.assign(row, { status, confidence });
    };
    mark(articleRows[3]!.id, 'ambiguous', 0.5);
    mark(articleRows[5]!.id, 'orphaned', null);
    mark(byQuote('Heart failure with reduced ejection fraction').id, 'changed', 0.82);
    mark(byQuote('Thenar wasting').id, 'changed', 0.76);
    await atTime(ago(2 * DAY), () => reportResolutions(statuses));

    // A stored PDF with three highlights.
    const bytes = new Uint8Array(await (await fetch(pdfUrl)).arrayBuffer());
    const documentId = await sha256Hex(bytes);
    const pdfAt = ago(6 * DAY);
    await atTime(pdfAt, async () => {
      await upsertDocument({
        id: documentId,
        title: 'Recommended Child and Adolescent Immunization Schedule, United States, 2025',
        pageCount: 18,
        byteLength: bytes.byteLength,
        originalUrl:
          'https://www.cdc.gov/vaccines/hcp/imz-schedules/downloads/child/0-18yrs-child-combined-schedule.pdf',
        textStatus: 'text',
      });
      await cacheDocumentBytes(documentId, new Blob([bytes], { type: 'application/pdf' }));
    });
    const pdfQuotes = [
      [
        2,
        'For those who fall behind or start late, provide catch-up vaccination at the earliest opportunity as indicated by the green bars.',
        0.12,
      ],
      [
        3,
        'A vaccine series does not need to be restarted, regardless of the time that has elapsed between doses.',
        0.16,
      ],
      [3, 'Maximum age for first dose is 14 weeks, 6 days.', 0.41],
    ] as const;
    for (const [i, [page, quote, y]] of pdfQuotes.entries()) {
      await atTime(pdfAt + (i + 1) * 4 * MINUTE, () =>
        savePdfHighlight({
          documentId,
          anchorSet: {
            type: 'pdf',
            textAlgorithm: 'sv-pdf-text-v1',
            documentFingerprint: documentId,
            pageNumber: page,
            rotation: 0,
            rects: [{ x: 0.08, y, w: 0.78, h: 0.018 }],
            textQuote: { exact: quote, prefix: '', suffix: '' },
            textPosition: { start: 120, end: 120 + quote.length },
            contentSignature: 'gallery',
            documentTextLength: 4000,
          },
          exactQuote: quote,
          kind: 'essential',
          color: DEFAULT_PALETTE.essential,
          bankId: bankIds.get('Microbiology')!,
          folderId: folderIds.get('Microbiology/Vaccines')!,
          userComment: i === 0 ? 'Catch-up rules: see Table 2.' : '',
          priority: 3,
          headingContext: page === 2 ? 'Table 1' : 'Table 2 (catch-up)',
          captureMethod: 'toolbar',
        }),
      );
    }

    // Flashcards: a cloze card for most highlights, with review history up to now. Each card has its
    // own generator: how many reviews fit depends on the time of day (study-day rollover), and that
    // must not change which cards exist.
    let carded = 0;
    for (const [i, s] of saved.entries()) {
      const c = rng(5000 + i);
      if (s.kind === 'question' || !s.quote.includes(s.cloze) || c.chance(0.08)) continue;
      const created = s.at + c.int(10, 90) * MINUTE;
      const [card] = await createCardsFromHighlight(
        s.id,
        [{ template: 'cloze', markup: s.quote.replace(s.cloze, `{{c1::${s.cloze}}}`) }],
        { now: created },
      );
      carded++;
      if (!card || c.chance(0.12)) continue; // still new
      // Most were studied up to today; some stopped a few days ago and are due or overdue now.
      const until = c.chance(0.72) ? NOW - HOUR : NOW - c.int(1, 4) * DAY;
      await reviewHistory(c, card.id, created, until);
    }
    const beta = byQuote('Cardioselective agents');
    await createCardsFromHighlight(
      beta.id,
      [
        {
          template: 'mcq',
          stem: 'Which beta blocker also blocks alpha-1 receptors?',
          choices: ['Atenolol', 'Carvedilol', 'Metoprolol', 'Bisoprolol'],
          correctIndex: 1,
          explanation: 'Carvedilol (and labetalol) add alpha-1 blockade, causing vasodilation.',
        },
      ],
      { now: ago(DAY) },
    );
    await createManualCards(
      [
        {
          template: 'basic',
          question: 'Antidote for a benzodiazepine overdose?',
          answer: 'Flumazenil (rarely used: it can precipitate seizures).',
        },
      ],
      { now: ago(3 * DAY) },
    );
    console.info(`[gallery] student: ${saved.length + 5} highlights, ${carded + 2} cards`);

    // Links between highlights (knowledge graph) and one knowledge point.
    const links: [string, string, 'related' | 'supports' | 'cause' | 'prerequisite'][] = [
      ['mask the adrenergic warning signs', 'Carvedilol blocks alpha-1', 'related'],
      ['Hypokalaemia, hypomagnesaemia', 'Torsades de pointes is a polymorphic', 'cause'],
      ['AUC-guided dosing', 'Trough concentrations above 15', 'supports'],
      ['Folate deficiency raises', 'Vitamin B12 deficiency causes', 'related'],
      [
        'competitively antagonise catecholamines',
        'Rate control with a beta blocker',
        'prerequisite',
      ],
      ['Secondary bacterial pneumonia', 'coagulase-positive', 'related'],
    ];
    for (const [from, to, type] of links) {
      await atTime(ago(4 * DAY), () =>
        createRelation({
          fromKind: 'highlight',
          fromId: byQuote(from).id,
          toKind: 'highlight',
          toId: byQuote(to).id,
          type,
        }),
      );
    }
    await atTime(ago(4 * DAY), () =>
      createKnowledgePoint({
        highlightId: beta.id,
        shortOneLiner: 'Cardioselective beta blockers (A to M) block beta-1 more than beta-2.',
        examPearl: 'Selectivity is lost at high doses: still use caution in asthma.',
        misconception: 'Cardioselective does not mean safe in severe asthma.',
      }),
    );

    // Trash: two highlights, a note and a folder deleted along the way.
    const trashed = [
      ['Digoxin toxicity causes yellow-green vision and nausea.', 'Digoxin - Wikipedia'],
      ['Lidocaine is a class IB antiarrhythmic.', 'Antiarrhythmic agent - Wikipedia'],
    ] as const;
    for (const [i, [quote, title]] of trashed.entries()) {
      const at = ago((20 - i * 7) * DAY);
      const res = await capture({
        url: `https://en.wikipedia.org/wiki/${title.split(' ')[0]}`,
        title,
        quote,
        at,
        bankId: bankIds.get('Cardiology')!,
      });
      await atTime(at + 2 * DAY, () => softDeleteHighlight(res.highlight.id));
    }
    await atTime(ago(15 * DAY), async () => {
      const note = await createNote({
        highlightId: byQuote('Atropine blocks').id,
        body: 'Draft: dose is 0.5 mg (check).',
      });
      await deleteNote(note.id);
      const old = await createFolder({
        bankId: bankIds.get('Anatomy')!,
        name: 'Old lecture notes',
      });
      await deleteFolder(old.id);
    });

    // Organisation: filing rules, a syllabus and saved searches.
    await atTime(ago(30 * DAY), async () => {
      await createFilingRule({
        name: 'CDC pages to Microbiology',
        match: {
          hosts: ['www.cdc.gov'],
          urlPrefixes: [],
          titleContains: [],
          quoteContains: [],
          tagIds: [],
          kinds: [],
          sourceTypes: [],
        },
        action: { bankId: bankIds.get('Microbiology')!, addTagIds: [tagIds.get('vaccines')!] },
        requireConfirm: true,
      });
      await createFilingRule({
        name: 'Formulas to Biochemistry',
        match: {
          hosts: [],
          urlPrefixes: [],
          titleContains: [],
          quoteContains: [],
          tagIds: [],
          kinds: ['formula'],
          sourceTypes: ['web'],
        },
        action: { bankId: bankIds.get('Biochemistry')!, addTagIds: [tagIds.get('formula')!] },
        requireConfirm: false,
      });
      const tag = (name: string) => [tagIds.get(name)!];
      await createSyllabus({
        name: 'USMLE Step 1 plan',
        nodes: [
          {
            title: 'Pharmacology',
            weight: 3,
            bankIds: [bankIds.get('Pharmacology')!],
            children: [
              { title: 'Pharmacokinetics', tagIds: tag('pharmacokinetics') },
              { title: 'Adverse effects', tagIds: tag('adverse-effects') },
            ],
          },
          {
            title: 'Cardiovascular',
            weight: 3,
            children: [
              { title: 'Arrhythmias and ECG', tagIds: [...tag('arrhythmia'), ...tag('ecg')] },
              { title: 'Cardiology (all)', bankIds: [bankIds.get('Cardiology')!] },
            ],
          },
          { title: 'Anatomy', weight: 2, bankIds: [bankIds.get('Anatomy')!] },
          {
            title: 'Microbiology',
            weight: 2,
            bankIds: [bankIds.get('Microbiology')!],
            children: [{ title: 'Vaccines', tagIds: tag('vaccines') }],
          },
          { title: 'Biochemistry', weight: 2, bankIds: [bankIds.get('Biochemistry')!] },
          { title: 'Renal and acid-base', weight: 1 },
        ],
      });
      const searches = [
        { name: 'High-yield', query: 'tag:high-yield' },
        { name: 'Weak areas', query: 'kind:weak_area' },
      ]
        .map((s, i) => createSavedSearch({ ...s, id: `saved-search-${i + 1}`, now: new Date() }))
        .flatMap((res) => (res.ok ? [res.search] : [])) satisfies SavedSearch[];
      await withWritableDb((db) =>
        db.meta.put({
          key: 'savedSearches',
          value: serializeSavedSearches(searches),
          updatedAt: new Date().toISOString(),
        }),
      );
    });

    // Site access: "always on" for two reference sites; the last save went to Pharmacology.
    await grantSites(ctx, ['https://en.wikipedia.org/*', 'https://www.ncbi.nlm.nih.gov/*']);
    await patchSettings({ lastBankId: bankIds.get('Pharmacology')! });
  },
};

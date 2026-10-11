// Test-only dataset for the human-readable exporters: ordinary content next to hostile content.
import type { ExportDataset } from './views';
import type { Row } from './types';

const at = (n: number) => new Date(Date.UTC(2026, 9, 1, 9, n)).toISOString();
const meta = (n: number): Row => ({
  schemaVersion: 1,
  createdAt: at(n),
  updatedAt: at(n),
  deletedAt: null,
});

const html = (start: number, exact: string): Row => ({
  type: 'html',
  textAlgorithm: 'sv-text-v1',
  textQuote: { exact, prefix: '', suffix: '' },
  textPosition: { start, end: start + exact.length },
  structuralPath: null,
  contentSignature: 'x',
  documentTextLength: 1000,
});

const highlight = (
  id: string,
  n: number,
  sourceId: string,
  exact: string,
  over: Row = {},
): Row => ({
  ...meta(n),
  id,
  sourceId,
  exactQuote: exact,
  normalizedQuote: exact.toLowerCase(),
  quoteHash: `${id.padEnd(64, '0')}`.slice(0, 64),
  anchorSet: html(100 + n, exact),
  kind: 'essential',
  color: 'amber',
  priority: 3,
  userComment: '',
  headingContext: null,
  captureMethod: 'toolbar',
  capturedAt: at(n),
  resolveStatus: 'resolved',
  resolveConfidence: 1,
  lastResolvedAt: null,
  ...over,
});

export const INJECTION_QUOTE = [
  '[[evil]] and ![[embedded note]] with <script>alert(1)</script>',
  '](javascript:alert(1)) [click](javascript:alert(2))',
  '# not a heading',
  '- not a list',
  '---',
  'title: pwned',
  '%% hidden %% ==marked== $x$',
].join('\n');

export function exportDataset(): ExportDataset {
  const banks: Row[] = [
    { ...meta(1), id: 'inbox-default', name: 'Inbox', color: 'blue', position: 0, isInbox: true },
    {
      ...meta(2),
      id: 'bank-cardio',
      name: 'Cardiology',
      color: 'red',
      position: 1,
      isInbox: false,
    },
    {
      ...meta(3),
      id: 'bank-weird',
      name: 'Exam: Q&A? <2026>/draft*',
      color: 'green',
      position: 2,
      isInbox: false,
    },
    { ...meta(4), id: 'bank-con', name: 'CON', color: 'teal', position: 3, isInbox: false },
    {
      ...meta(5),
      id: 'bank-gone',
      name: 'Deleted bank',
      color: 'teal',
      position: 4,
      isInbox: false,
      deletedAt: at(9),
    },
  ];
  const folders: Row[] = [
    {
      ...meta(1),
      id: 'folder-pharm',
      bankId: 'bank-cardio',
      parentFolderId: null,
      name: 'Pharmacology',
      position: 0,
    },
    {
      ...meta(2),
      id: 'folder-anti',
      bankId: 'bank-cardio',
      parentFolderId: 'folder-pharm',
      name: 'Anti/platelets: "COX"',
      position: 0,
    },
  ];
  const sources: Row[] = [
    {
      ...meta(1),
      id: 'src-a',
      type: 'web',
      urlKey: 'https://example.com/a',
      visitedKey: 'https://example.com/a',
      originalUrl: 'https://example.com/a(b)?x=1&y=2',
      canonicalUrl: null,
      host: 'example.com',
      title: 'Aspirin [mechanism] *notes*',
    },
    {
      ...meta(2),
      id: 'src-unsafe',
      type: 'web',
      urlKey: 'x',
      visitedKey: 'x',
      originalUrl: 'javascript:alert(1)',
      canonicalUrl: null,
      host: 'evil.test',
      title: 'Unsafe link source',
    },
    {
      ...meta(3),
      id: 'src-pdf',
      type: 'pdf',
      documentId: 'doc-1',
      urlKey: 'pdf:doc-1',
      visitedKey: 'pdf:doc-1',
      originalUrl: 'https://example.com/paper.pdf',
      canonicalUrl: null,
      host: 'example.com',
      title: 'Cardiology Paper (2026)',
    },
  ];
  const highlights: Row[] = [
    highlight(
      'hl-0001',
      10,
      'src-a',
      'Aspirin irreversibly inhibits COX-1.\nIt also reduces thromboxane A2.',
      {
        userComment: 'Remember: low dose = antiplatelet.',
        headingContext: 'Mechanism',
        kind: 'essential',
        priority: 5,
        capturedUrl: 'https://example.com/a?utm=1',
        capturedTitle: 'Aspirin [mechanism] *notes*',
      },
    ),
    highlight('hl-0002', 11, 'src-unsafe', INJECTION_QUOTE, {
      userComment: '@SUM(1+1) and <img src=x onerror=alert(1)>',
      kind: 'question',
    }),
    highlight('hl-0003', 12, 'src-a', '=HYPERLINK("http://evil.test","click")', {
      userComment: '+1 then -2\n=3',
      kind: 'formula',
      priority: 1,
    }),
    highlight('hl-0004', 13, 'src-pdf', 'Statins reduce LDL by 30–55%.', {
      anchorSet: {
        type: 'pdf',
        textAlgorithm: 'sv-pdf-text-v1',
        documentFingerprint: 'abcdef012345',
        pageNumber: 3,
        rotation: 0,
        rects: [{ x: 0.1, y: 0.1, w: 0.5, h: 0.02 }],
        textQuote: { exact: 'Statins', prefix: '', suffix: '' },
        textPosition: { start: 4, end: 11 },
        contentSignature: 'x',
        documentTextLength: 900,
      },
      kind: 'exception',
    }),
    highlight('hl-0005', 14, 'src-a', 'Ünïcödé 日本語 \u{1F9EC} שלום', { kind: 'differential' }),
    highlight('hl-0006', 15, 'src-a', 'This one was deleted', { deletedAt: at(20) }),
    highlight(
      'hl-0007',
      16,
      'src-a',
      'Filed in two banks with "quotes", commas, and a tab\there.',
      {
        userComment: 'multi',
      },
    ),
  ];
  const highlightBanks: Row[] = [
    { highlightId: 'hl-0001', bankId: 'bank-cardio', folderId: 'folder-anti', addedAt: at(10) },
    { highlightId: 'hl-0002', bankId: 'inbox-default', folderId: null, addedAt: at(11) },
    { highlightId: 'hl-0003', bankId: 'bank-weird', folderId: null, addedAt: at(12) },
    { highlightId: 'hl-0004', bankId: 'bank-cardio', folderId: null, addedAt: at(13) },
    { highlightId: 'hl-0005', bankId: 'bank-con', folderId: null, addedAt: at(14) },
    { highlightId: 'hl-0006', bankId: 'inbox-default', folderId: null, addedAt: at(15) },
    { highlightId: 'hl-0007', bankId: 'bank-cardio', folderId: 'folder-pharm', addedAt: at(16) },
    { highlightId: 'hl-0007', bankId: 'bank-weird', folderId: null, addedAt: at(16) },
  ];
  const tags: Row[] = [
    {
      ...meta(1),
      id: 'tag-1',
      name: 'heart failure',
      nameKey: 'heart failure',
      color: null,
      aliases: [],
    },
    { ...meta(2), id: 'tag-2', name: '2026', nameKey: '2026', color: null, aliases: [] },
    { ...meta(3), id: 'tag-3', name: 'ünï/cöde #x', nameKey: 'x', color: null, aliases: [] },
  ];
  const highlightTags: Row[] = [
    { highlightId: 'hl-0001', tagId: 'tag-1', addedAt: at(10) },
    { highlightId: 'hl-0001', tagId: 'tag-2', addedAt: at(10) },
    { highlightId: 'hl-0002', tagId: 'tag-3', addedAt: at(11) },
  ];
  const notes: Row[] = [
    {
      ...meta(30),
      id: 'note-1',
      highlightId: 'hl-0001',
      sourceId: null,
      title: 'Study note',
      body: 'Why it matters:\n\n- irreversible acetylation\n- platelets cannot make new COX',
      pinned: true,
    },
  ];
  const decks: Row[] = [
    { ...meta(1), id: 'deck-1', bankId: 'bank-cardio', name: 'Cardiology::Pharm', settings: {} },
    { ...meta(1), id: 'deck-2', bankId: null, name: 'Loose', settings: {} },
  ];
  const card = (id: string, over: Row): Row => ({
    ...meta(40),
    id,
    deckId: 'deck-1',
    knowledgePointId: null,
    highlightId: 'hl-0001',
    sourceQuote: null,
    cardType: 'basic',
    front: 'What does aspirin inhibit?',
    back: 'COX-1 (irreversibly).',
    cloze: null,
    tags: ['pharm', 'high yield'],
    suspended: false,
    ...over,
  });
  const cards: Row[] = [
    card('card-001', {}),
    card('card-002', {
      cardType: 'cloze',
      front: 'cloze',
      back: 'Extra: dose matters',
      cloze: {
        text: 'Aspirin inhibits {{c1::COX-1::enzyme}} and {{c2::thromboxane {{c3::A2}}}} synthesis',
        deletions: [],
        activeIndex: 2,
      },
    }),
    card('card-003', {
      cardType: 'cloze',
      front: 'cloze',
      back: '',
      cloze: { text: '{{c1::One}} and {{c2::two}}', deletions: [], activeIndex: null },
      deckId: 'deck-2',
      highlightId: null,
      sourceQuote: 'One and two are numbers <b>',
    }),
    card('card-004', {
      cardType: 'mcq',
      front: 'Which enzyme?',
      back: 'COX-1',
      choices: [
        { id: 'a', text: 'COX-1' },
        { id: 'b', text: 'LOX' },
      ],
      answerChoiceId: 'a',
      explanation: 'Irreversible acetylation.',
    }),
    card('card-005', {
      suspended: true,
      front: "=cmd|' /C calc'!A0",
      back: '"quoted"\tand tab\nnewline',
    }),
    card('card-006', { deletedAt: at(50) }),
  ];
  return {
    banks,
    sources,
    folders,
    highlights,
    highlightBanks,
    tags,
    highlightTags,
    notes,
    decks,
    cards,
  };
}

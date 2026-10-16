import { COLOR_IDS, MAX_BANK_NAME_CHARS, MAX_FOLDER_NAME_CHARS } from '@shared';
import {
  addToBank,
  attachTags,
  createBank,
  createCardsFromHighlights,
  createFolder,
  createNote,
  createTag,
  setBankColor,
} from '@storage';
import {
  DAY,
  MINUTE,
  ago,
  atTime,
  capture,
  completeOnboarding,
  grantSites,
  patchSettings,
  pickKind,
  pickPriority,
  rng,
  type Scenario,
} from './kit';
import { BANKS } from './medical';

/**
 * Layout stress: 30 banks with long names and deep folders, 64 tags, 1,200 highlights with long
 * titles, long quotes, many tags, right-to-left text and 400 new flashcards.
 */
const HIGHLIGHTS = 1200;
const BANK_COUNT = 30;
const SOURCES = 140;

const SUBJECTS = [
  'Clinical Pharmacology and Therapeutics',
  'Cardiovascular Physiology and Pathophysiology',
  'Gross Anatomy, Embryology and Clinical Imaging',
  'Medical Microbiology, Infection and Immunity',
  'Biochemistry, Molecular Biology and Genetics',
  'Renal, Fluid, Electrolyte and Acid-Base Disorders',
  'Respiratory Medicine and Critical Care',
  'Neurology, Neuroanatomy and Behavioural Science',
  'Endocrinology, Diabetes and Metabolism',
  'Haematology and Oncology',
];
const RTL = [
  [
    'يُعدّ الرجفان الأذيني أكثر اضطرابات النظم القلبي شيوعًا لدى البالغين، ويزيد خطر السكتة الدماغية.',
    'الرجفان الأذيني - ويكيبيديا',
  ],
  [
    'פרפור פרוזדורים הוא הפרעת הקצב הנפוצה ביותר במבוגרים ומעלה את הסיכון לשבץ.',
    'פרפור פרוזדורים – ויקיפדיה',
  ],
] as const;

export const heavy: Scenario = {
  id: 'heavy',
  title: 'Stress: 30 banks, 1,200 highlights, long text everywhere',
  tab: 'reference',
  async seed(ctx) {
    const r = rng(777);
    await completeOnboarding();
    const facts = BANKS.flatMap((b) => b.sources.flatMap((s) => s.facts.map(([q]) => q)));

    const banks: { id: string; folders: string[] }[] = [];
    const tagIds: string[] = [];
    await atTime(ago(400 * DAY), async () => {
      for (let i = 0; i < BANK_COUNT; i++) {
        const name =
          i % 3 === 0
            ? `${SUBJECTS[i % SUBJECTS.length]} for the Integrated Second-Year Curriculum, Block ${i + 1} (revision copy with past-paper annotations)`
            : `${SUBJECTS[i % SUBJECTS.length]} ${i + 1}`;
        // Names at the length limit.
        const bank = await createBank(name.slice(0, MAX_BANK_NAME_CHARS).trim());
        await setBankColor(bank.id, COLOR_IDS[i % COLOR_IDS.length]!);
        const folders: string[] = [];
        let parent: string | null = null;
        for (let depth = 0; depth < (i % 4) + 2; depth++) {
          const folder = await createFolder({
            bankId: bank.id,
            name: `Week ${depth + 1}: ${SUBJECTS[(i + depth) % SUBJECTS.length]} lecture series, part ${depth + 1}`
              .slice(0, MAX_FOLDER_NAME_CHARS)
              .trim(),
            parentFolderId: parent,
          });
          folders.push(folder.id);
          parent = folder.id;
        }
        banks.push({ id: bank.id, folders });
      }
      for (let i = 0; i < 64; i++) {
        const name =
          i % 5 === 0 ? `exam-${2026 + (i % 3)}-paper-${i}-differential-diagnosis` : `topic-${i}`;
        tagIds.push((await createTag(name)).tag.id);
      }
    });

    const ids: string[] = [];
    for (let i = 0; i < HIGHLIGHTS; i++) {
      const source = i % SOURCES;
      const bank = banks[source % BANK_COUNT]!;
      const rtl = i % 97 === 0 ? RTL[(i / 97) % 2]! : null;
      const parts = r.int(1, i % 10 === 0 ? 14 : 3);
      const quote =
        rtl?.[0] ??
        Array.from({ length: parts }, (_, k) => facts[(i * 7 + k) % facts.length]).join(' ');
      const title =
        rtl?.[1] ??
        `${SUBJECTS[source % SUBJECTS.length]}: an extremely detailed review article with a very long title, chapter ${source + 1} of the online reference textbook`;
      const at = ago(((HIGHLIGHTS - i) / HIGHLIGHTS) * 360 * DAY) + r.int(0, 50) * MINUTE;
      const res = await capture({
        url: `https://reference.example.org/textbook/chapter-${source + 1}/section-${i % 7}?edition=2026`,
        title,
        quote: quote.slice(0, 5000),
        at,
        heading: `Section ${i % 7}: ${SUBJECTS[(source + 3) % SUBJECTS.length]}`,
        kind: pickKind(r),
        bankId: bank.id,
        comment: i % 4 === 0 ? `Long personal comment ${i}: ${facts[i % facts.length]}` : '',
        priority: pickPriority(r),
      });
      const id = res.highlight.id;
      ids.push(id);
      if (i % 3 === 0) {
        const folderId = bank.folders[i % bank.folders.length]!;
        await atTime(at, () => addToBank({ highlightId: id, bankId: bank.id, folderId }));
      }
      if (i % 2 === 0) {
        const tags = [...new Set(Array.from({ length: r.int(1, 8) }, () => r.pick(tagIds)))];
        await atTime(at, () => attachTags({ highlightIds: [id], tagIds: tags }));
      }
      if (i % 25 === 0) {
        await atTime(at, () =>
          createNote({
            highlightId: id,
            body: `## Note ${i}\n\n${facts.slice(i % 20, (i % 20) + 6).join('\n\n')}`,
          }),
        );
      }
    }

    // 400 new cards (one bulk write per 100).
    for (let start = 0; start < 400; start += 100) {
      await createCardsFromHighlights(
        ids.slice(start, start + 100).map((highlightId, k) => ({
          highlightId,
          template: {
            template: 'basic',
            question: `Card ${start + k + 1}: ${facts[(start + k) % facts.length]!.slice(0, 120)}?`,
            answer: facts[(start + k + 1) % facts.length]!,
          },
        })),
        { now: ago(30 * DAY) },
      );
    }

    await grantSites(ctx, ['https://reference.example.org/*', 'https://en.wikipedia.org/*']);
    await patchSettings({ lastBankId: banks[0]!.id });
  },
};

/** Test-only helpers (never imported by production code). */
import type { SearchDocument } from './schema';

/** mulberry32: small, fast, deterministic. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let counter = 0;

export function doc(overrides: Partial<SearchDocument> = {}): SearchDocument {
  counter++;
  return {
    id: `d${counter}`,
    docType: 'highlight',
    highlightId: null,
    title: '',
    url: null,
    host: null,
    quote: '',
    comment: '',
    headingContext: null,
    tags: [],
    banks: [],
    folderPath: [],
    kind: 'essential-fact',
    priority: 3,
    resolveStatus: 'resolved',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

const MEDICAL = [
  'aortic',
  'stenosis',
  'mitral',
  'valve',
  'ventricle',
  'atrium',
  'myocardial',
  'infarction',
  'ischemia',
  'membrane',
  'transport',
  'potential',
  'sodium',
  'potassium',
  'channel',
  'receptor',
  'neuron',
  'synapse',
  'cortex',
  'cerebellum',
  'hemorrhage',
  'thrombosis',
  'embolism',
  'anemia',
  'leukocyte',
  'platelet',
  'plasma',
  'insulin',
  'glucose',
  'pancreas',
  'hepatic',
  'renal',
  'nephron',
  'glomerulus',
  'bronchus',
  'alveolus',
  'pneumonia',
  'asthma',
  'fibrosis',
  'carcinoma',
  'lymphoma',
  'metastasis',
  'antibody',
  'antigen',
  'cytokine',
  'macrophage',
  'mitochondria',
  'ribosome',
  'nucleus',
  'enzyme',
  'substrate',
  'ligand',
  'gradient',
  'diffusion',
  'osmosis',
  'tomography',
  'ultrasound',
  'resonance',
  'contrast',
  'gadolinium',
  'radiograph',
  'lesion',
  'hypertension',
  'hypotension',
  'tachycardia',
  'bradycardia',
  'arrhythmia',
  'ejection',
  'fraction',
  'diastolic',
  'systolic',
  'murmur',
  'cyanosis',
  'dyspnea',
  'edema',
  'oedema',
  'syndrome',
  'diagnosis',
  'differential',
  'prognosis',
  'therapy',
  'dose',
  'mg',
  'dl',
  'ml',
  'kg',
  'mmol',
];

const SYLLABLES = [
  'ba',
  'ko',
  'ri',
  'tu',
  'sen',
  'mor',
  'plex',
  'vil',
  'dor',
  'na',
  'lu',
  'xe',
  'fi',
];

const STOPPY = ['the', 'of', 'and', 'in', 'is', 'a', 'to', 'with', 'for', 'as'];

/**
 * `size` distinct words ordered by frequency rank. The real medical words are scattered over the
 * first few thousand ranks, so some are common (a few % of highlights) and some rare, like real notes.
 */
function vocabulary(rand: () => number, size: number): string[] {
  const seen = new Set<string>(MEDICAL);
  const filler: string[] = [];
  while (filler.length + MEDICAL.length < size) {
    const n = 2 + Math.floor(rand() * 4);
    let w = '';
    for (let i = 0; i < n; i++) w += SYLLABLES[Math.floor(rand() * SYLLABLES.length)]!;
    if (seen.has(w)) continue;
    seen.add(w);
    filler.push(w);
  }
  const out = filler;
  for (const m of MEDICAL) out.splice(Math.floor(rand() * Math.min(out.length, 4000)), 0, m);
  return out;
}

export const CORPUS_BANKS = Array.from(
  { length: 24 },
  (_, i) =>
    [
      'Cardiology',
      'Neurology',
      'Renal',
      'Pulmonology',
      'Radiology',
      'Physics',
      'Pathology',
      'Pharmacology',
    ][i % 8]! + (i >= 8 ? ` ${Math.floor(i / 8) + 1}` : ''),
);
export const CORPUS_TAGS = Array.from({ length: 120 }, (_, i) => `tag-${i}`);
export const CORPUS_KINDS = [
  'essential-fact',
  'formula',
  'exception',
  'differential',
  'weak-area',
  'correction',
  'question',
];
const HOSTS = [
  'en.wikipedia.org',
  'radiopaedia.org',
  'ncbi.nlm.nih.gov',
  'pubmed.ncbi.nlm.nih.gov',
  'example.com',
  'khanacademy.org',
];
const STATUSES = ['resolved', 'resolved', 'resolved', 'approximate', 'orphaned'];

/**
 * Deterministic, realistic-ish corpus: Zipf-like word frequencies over ~12,000 terms, a handful of
 * stop words, sources shared by several highlights, ~3% soft-deleted, ~35% with comments.
 */
export function generateCorpus(count: number, seed = 20261011): SearchDocument[] {
  const rand = prng(seed);
  const vocab = vocabulary(rand, 12000);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const word = (): string => {
    if (rand() < 0.12) return pick(STOPPY);
    return vocab[Math.floor(vocab.length * Math.pow(rand(), 2))]!;
  };
  const words = (n: number): string => Array.from({ length: n }, word).join(' ');
  const docs: SearchDocument[] = [];
  for (let i = 0; i < count; i++) {
    const sourceNo = Math.floor(i / 4);
    const deleted = rand() < 0.03;
    const day = 1 + Math.floor(rand() * 27);
    const tagN = Math.floor(rand() * 4);
    const bankN = 1 + (rand() < 0.2 ? 1 : 0);
    const banks = Array.from(new Set(Array.from({ length: bankN }, () => pick(CORPUS_BANKS))));
    docs.push({
      id: `h-${seed}-${i}`,
      docType: rand() < 0.15 ? 'note' : 'highlight',
      highlightId: null,
      title: `Source ${sourceNo}: ${words(3 + Math.floor(rand() * 5))}`,
      url: `https://${HOSTS[sourceNo % HOSTS.length]}/page/${sourceNo}`,
      host: HOSTS[sourceNo % HOSTS.length]!,
      quote: words(15 + Math.floor(rand() * 55)),
      comment: rand() < 0.35 ? words(4 + Math.floor(rand() * 26)) : '',
      headingContext: rand() < 0.6 ? words(2 + Math.floor(rand() * 4)) : null,
      tags: Array.from(new Set(Array.from({ length: tagN }, () => pick(CORPUS_TAGS)))),
      banks,
      folderPath:
        rand() < 0.5
          ? [pick(['Valves', 'Imaging', 'Physiology', 'Drugs']), `Topic ${Math.floor(rand() * 20)}`]
          : [],
      kind: pick(CORPUS_KINDS),
      priority: 1 + Math.floor(rand() * 5),
      resolveStatus: pick(STATUSES),
      updatedAt: `2026-0${1 + Math.floor(rand() * 9)}-${String(day).padStart(2, '0')}T10:00:00.000Z`,
      deletedAt: deleted ? '2026-10-01T00:00:00.000Z' : null,
    });
  }
  return docs;
}

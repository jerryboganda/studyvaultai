import { MAX_CLOZE_INDEX, parseCloze } from '@study';
import type { TemplateInput, TemplateName } from '@storage';

/**
 * State of the card editor as plain strings, and its conversion to the repo's `TemplateInput`.
 * Pure: the editor previews with exactly the builders the repo stores with.
 */

export interface EditorState {
  template: TemplateName;
  basic: { question: string; answer: string; explanation: string };
  definition: { term: string; definition: string; example: string };
  compare: { left: string; right: string; rows: { aspect: string; left: string; right: string }[] };
  cloze: { markup: string; perDeletion: boolean; explanation: string };
  mcq: {
    stem: string;
    choices: string[];
    correctIndex: number;
    explanation: string;
    shuffle: boolean;
  };
  /** Comma separated. */
  tags: string;
}

/** The quote seeds the cloze text (the learner wraps words in it); every other field starts empty. */
export function initialEditorState(
  quote: string | null,
  template: TemplateName = 'basic',
): EditorState {
  return {
    template,
    basic: { question: '', answer: '', explanation: '' },
    definition: { term: '', definition: '', example: '' },
    compare: { left: '', right: '', rows: [{ aspect: '', left: '', right: '' }] },
    cloze: { markup: quote ?? '', perDeletion: true, explanation: '' },
    mcq: { stem: '', choices: ['', '', '', ''], correctIndex: 0, explanation: '', shuffle: false },
    tags: '',
  };
}

const tagsOf = (s: string): string[] =>
  s
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

const opt = (s: string): { explanation?: string } => (s.trim() === '' ? {} : { explanation: s });

export function toTemplateInput(state: EditorState): TemplateInput {
  const tags = tagsOf(state.tags);
  switch (state.template) {
    case 'basic':
      return {
        template: 'basic',
        question: state.basic.question,
        answer: state.basic.answer,
        ...opt(state.basic.explanation),
        tags,
      };
    case 'definition':
      return {
        template: 'definition',
        term: state.definition.term,
        definition: state.definition.definition,
        ...(state.definition.example.trim() === '' ? {} : { example: state.definition.example }),
        tags,
      };
    case 'compare':
      return {
        template: 'compare',
        left: state.compare.left,
        right: state.compare.right,
        rows: state.compare.rows.filter((r) => r.aspect.trim() || r.left.trim() || r.right.trim()),
        tags,
      };
    case 'cloze':
      return {
        template: 'cloze',
        markup: state.cloze.markup,
        perDeletion: state.cloze.perDeletion,
        ...opt(state.cloze.explanation),
        tags,
      };
    case 'mcq': {
      // Blank options are dropped (an unused fourth slot is not an error); the key follows its text.
      const kept: string[] = [];
      let correctIndex = -1;
      state.mcq.choices.forEach((text, i) => {
        if (text.trim() === '') return;
        if (i === state.mcq.correctIndex) correctIndex = kept.length;
        kept.push(text);
      });
      return {
        template: 'mcq',
        stem: state.mcq.stem,
        choices: kept,
        correctIndex,
        shuffle: state.mcq.shuffle,
        ...opt(state.mcq.explanation),
        tags,
      };
    }
  }
}

/** The next free deletion number: one more than the highest used (1 when there is none). */
export function nextClozeIndex(markup: string): number {
  const { indexes } = parseCloze(markup);
  const max = indexes.length > 0 ? Math.max(...indexes) : 0;
  return Math.min(MAX_CLOZE_INDEX, max + 1);
}

export type WrapResult =
  | { ok: true; text: string; selectionStart: number; selectionEnd: number }
  | { ok: false; error: string };

/**
 * Wrap the selected characters of the cloze text in `{{cN::...}}`. Whitespace at the edges of the
 * selection stays outside the deletion; a selection that contains cloze delimiters is refused
 * (it would corrupt the markup).
 */
export function clozeWrap(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  index: number,
  hint = '',
): WrapResult {
  if (
    !Number.isInteger(selectionStart) ||
    !Number.isInteger(selectionEnd) ||
    selectionStart < 0 ||
    selectionEnd > text.length ||
    selectionEnd <= selectionStart
  ) {
    return { ok: false, error: 'Select the word or phrase to hide first.' };
  }
  if (!Number.isInteger(index) || index < 1 || index > MAX_CLOZE_INDEX) {
    return { ok: false, error: `The deletion number must be between 1 and ${MAX_CLOZE_INDEX}.` };
  }
  let start = selectionStart;
  let end = selectionEnd;
  while (start < end && /\s/.test(text[start] ?? '')) start += 1;
  while (end > start && /\s/.test(text[end - 1] ?? '')) end -= 1;
  const span = text.slice(start, end);
  if (span === '') return { ok: false, error: 'The selection is only spaces.' };
  if (span.includes('{{') || span.includes('}}') || span.includes('::')) {
    return {
      ok: false,
      error: 'The selection contains cloze markup. Select plain text only.',
    };
  }
  const h = hint.trim();
  if (h.includes('{{') || h.includes('}}') || h.includes('::')) {
    return { ok: false, error: 'The hint cannot contain {{, }} or ::.' };
  }
  const open = `{{c${index}::`;
  const close = `${h ? `::${h}` : ''}}}`;
  const wrapped = `${text.slice(0, start)}${open}${span}${close}${text.slice(end)}`;
  return {
    ok: true,
    text: wrapped,
    selectionStart: start + open.length,
    selectionEnd: start + open.length + span.length,
  };
}

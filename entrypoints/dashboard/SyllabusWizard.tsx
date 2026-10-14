import { useId, useMemo, useRef, useState } from 'react';
import { ClipboardPaste, FilePlus2, Layers, Library, ListTree, Pencil, Plus } from 'lucide-react';
import {
  MAX_SYLLABUS_DEPTH,
  MAX_SYLLABUS_NAME_CHARS,
  MAX_SYLLABUS_NODES,
  MAX_SYLLABUS_TITLE_CHARS,
} from '@shared';
import type { SyllabusNodeInput } from '@storage';
import { ChoiceCards, ChunkyButton, InfoTip, InlineNotice, errorMessage, plural } from '@ui';
import { JumpWizard, type JumpStep } from './JumpWizard';
import { Chip } from './moreKit';
import { OUTLINE_MAX_CHARS, outlineToInputs, parseOutline } from './syllabusModel';

type Start = 'empty' | 'paste' | 'banks';
const PREVIEW_LINES = 12;

type PreviewLine = { depth: number; title: string; weight?: number };

/** Topics of an outline as indented lines, for the preview. */
function previewLines(
  topics: ReadonlyArray<{ title: string; weight?: number; children: unknown[] }>,
): PreviewLine[] {
  const lines: PreviewLine[] = [];
  const walk = (list: typeof topics, depth: number) => {
    for (const t of list) {
      if (lines.length > PREVIEW_LINES) return;
      lines.push({
        depth,
        title: t.title,
        ...(t.weight === undefined ? {} : { weight: t.weight }),
      });
      walk(t.children as typeof topics, depth + 1);
    }
  };
  walk(topics, 1);
  return lines;
}

/**
 * New syllabus as a wizard (UX_DESIGN 10): Start from (blank, paste an outline, or one topic per
 * bank) · Paste outline (paste only: a live dry run with the problems by line) · Name it · Looks
 * good? (each answer with a way back to it). Nothing is saved before the last step. Mapping topics
 * to banks and tags happens in the editor that opens next.
 */
export function SyllabusWizard({
  starters,
  startersReason,
  onCreate,
  onCancel,
}: {
  /** One topic per bank, for "My banks". */
  starters: SyllabusNodeInput[];
  /** Why "My banks" cannot be used now (loading, or no banks besides the Inbox). */
  startersReason: string | undefined;
  onCreate(name: string, nodes: SyllabusNodeInput[]): Promise<void>;
  onCancel(): void;
}) {
  const uid = useId();
  const [start, setStart] = useState<Start | null>(null);
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const parsed = useMemo(() => parseOutline(text), [text]);

  const fallback =
    start === 'paste'
      ? parsed.name || 'Imported outline'
      : start === 'banks'
        ? 'From my banks'
        : '';
  const finalName = (name.trim() || fallback).slice(0, MAX_SYLLABUS_NAME_CHARS);
  const nodes: SyllabusNodeInput[] =
    start === 'paste' ? outlineToInputs(parsed.topics) : start === 'banks' ? starters : [];
  const lines = useMemo<PreviewLine[]>(
    () =>
      start === 'paste'
        ? previewLines(parsed.topics)
        : start === 'banks'
          ? starters.map((s) => ({ depth: 1, title: s.title }))
          : [],
    [start, parsed, starters],
  );
  const count = start === 'paste' ? parsed.count : nodes.length;
  const depth = start === 'paste' ? parsed.depth : nodes.length > 0 ? 1 : 0;

  const pasteReason =
    text.trim() === ''
      ? 'Paste an outline first.'
      : parsed.errors.length > 0
        ? 'Fix the problems listed first.'
        : parsed.count === 0
          ? 'No topics were found in the text.'
          : null;

  const finish = async () => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await onCreate(finalName, nodes);
    } catch (err) {
      setSaveError(errorMessage(err, 'Could not create the syllabus. Try again.'));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  const change = (step: string, what: string, go: (id: string) => void) => (
    <ChunkyButton
      size="sm"
      variant="ghost"
      icon={Pencil}
      aria-label={`Change ${what}`}
      onClick={() => go(step)}
    >
      Change
    </ChunkyButton>
  );

  const steps: JumpStep[] = [
    {
      id: 'start',
      title: 'Start from',
      validate: () =>
        start === null ? 'Pick how to start.' : start === 'banks' ? (startersReason ?? null) : null,
      content: ({ error, errorId }) => (
        <ChoiceCards<Start>
          label="Start from"
          options={[
            { value: 'empty', label: 'Blank', hint: 'Add topics later', icon: FilePlus2 },
            {
              value: 'paste',
              label: 'Paste outline',
              hint: 'From a list',
              icon: ClipboardPaste,
              tone: 'violet',
            },
            {
              value: 'banks',
              label: 'My banks',
              hint: startersReason ? 'No banks yet' : 'One topic each',
              icon: Library,
              tone: 'success',
            },
          ]}
          value={start}
          onChange={setStart}
          invalid={error !== null}
          {...(error ? { describedBy: errorId } : {})}
        />
      ),
    },
    ...(start === 'paste'
      ? [
          {
            id: 'paste',
            title: 'Paste outline',
            validate: () => pasteReason,
            content: ({ error, errorId }) => (
              <>
                <div className="mv-field">
                  <span className="syl-wiz-label">
                    <label htmlFor={`${uid}-text`}>Outline</label>
                    <InfoTip label="What an outline looks like">
                      A nested list (bullets, numbers or indented lines) or Markdown headings. A
                      first “# Title” line names it; “(weight 2)” at the end of a line sets a
                      weight. Up to {MAX_SYLLABUS_NODES} topics in {MAX_SYLLABUS_DEPTH} levels,
                      titles of at most {MAX_SYLLABUS_TITLE_CHARS} characters,{' '}
                      {OUTLINE_MAX_CHARS.toLocaleString()} characters in all.
                    </InfoTip>
                  </span>
                  <textarea
                    id={`${uid}-text`}
                    className="sv-control syl-wiz-outline"
                    rows={8}
                    value={text}
                    spellCheck={false}
                    dir="auto"
                    placeholder={'# Cardiology\n- Heart failure\n  - Drugs\n- Arrhythmias'}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? errorId : undefined}
                    onChange={(e) => setText(e.target.value)}
                    data-testid="syllabus-import-text"
                  />
                </div>
                <div aria-live="polite" data-testid="syllabus-import-summary" className="mv-row">
                  {text.trim() === '' ? (
                    <span className="mv-line">The check appears as you paste.</span>
                  ) : parsed.errors.length > 0 ? (
                    <span className="mv-line">This outline cannot be used yet:</span>
                  ) : (
                    <>
                      <Chip icon={ListTree} tone="success">
                        {plural(parsed.count, 'topic')}
                      </Chip>
                      <Chip icon={Layers}>{plural(parsed.depth, 'level')}</Chip>
                      {parsed.name ? <Chip tone="primary">“{parsed.name}”</Chip> : null}
                    </>
                  )}
                </div>
                {parsed.errors.length > 0 ? (
                  <ul className="syl-issues" data-testid="syllabus-import-errors">
                    {parsed.errors.slice(0, 8).map((e, i) => (
                      <li key={`${e.line}-${i}`}>
                        {e.line > 0 ? `Line ${e.line}: ` : ''}
                        {e.message}
                      </li>
                    ))}
                    {parsed.errors.length > 8 ? (
                      <li>…and {parsed.errors.length - 8} more.</li>
                    ) : null}
                  </ul>
                ) : null}
                {parsed.notes.length > 0 && parsed.errors.length === 0 ? (
                  <details className="syl-notes">
                    <summary>{plural(parsed.notes.length, 'line')} read with a guess</summary>
                    <ul>
                      {parsed.notes.slice(0, 12).map((n, i) => (
                        <li key={`${n.line}-${i}`}>
                          Line {n.line}: {n.message}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </>
            ),
          } satisfies JumpStep,
        ]
      : []),
    {
      id: 'name',
      title: 'Name it',
      validate: () => (finalName.trim() === '' ? 'Give the syllabus a name.' : null),
      content: ({ error, errorId }) => (
        <div className="mv-field">
          <label htmlFor={`${uid}-name`}>Syllabus name</label>
          <input
            id={`${uid}-name`}
            className="sv-control"
            value={name}
            placeholder={fallback || 'Cardiology exam'}
            maxLength={MAX_SYLLABUS_NAME_CHARS}
            dir="auto"
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => setName(e.target.value)}
            data-testid="name-input"
          />
          {name.trim() === '' && fallback ? (
            <p className="mv-line">Empty uses “{fallback}”.</p>
          ) : null}
        </div>
      ),
    },
    {
      id: 'review',
      title: 'Looks good?',
      content: ({ goTo }) => (
        <>
          <div className="syl-review">
            <span className="syl-review__art sv-art--success" aria-hidden="true">
              <ListTree strokeWidth={2.4} />
            </span>
            <div className="syl-review__rows">
              <div className="syl-review__row">
                <strong className="mv-wrap mv-grow" dir="auto">
                  {finalName}
                </strong>
                {change('name', 'the name', goTo)}
              </div>
              <div className="syl-review__row">
                <span className="mv-row mv-grow">
                  <Chip icon={ListTree} tone="success">
                    {plural(count, 'topic')}
                  </Chip>
                  <Chip icon={Layers}>{plural(depth, 'level')}</Chip>
                </span>
                {change(start === 'paste' ? 'paste' : 'start', 'the topics', goTo)}
              </div>
            </div>
          </div>
          {lines.length > 0 ? (
            <ol
              className="syl-preview"
              aria-label="Preview of the topics"
              data-testid="syllabus-import-preview"
            >
              {lines.slice(0, PREVIEW_LINES).map((l, i) => (
                <li key={i} className={`syl-preview__d${Math.min(l.depth, 4)}`} dir="auto">
                  {l.title}
                  {l.weight !== undefined ? (
                    <span className="mv-meta"> (weight {l.weight})</span>
                  ) : null}
                </li>
              ))}
              {lines.length > PREVIEW_LINES ? <li className="mv-meta">…and more.</li> : null}
            </ol>
          ) : null}
          <p className="mv-line syl-review__hint">
            <Plus aria-hidden="true" />{' '}
            {lines.length > 0
              ? 'Map topics to banks and tags next.'
              : 'Add topics in the editor next.'}
          </p>
          {saving ? (
            <p className="mv-line" role="status">
              Saving…
            </p>
          ) : null}
          {saveError ? (
            <InlineNotice tone="error" title="Not saved">
              {saveError}
            </InlineNotice>
          ) : null}
        </>
      ),
    },
  ];

  return (
    <JumpWizard
      className="mv-wiz syl-wiz"
      label="New syllabus"
      steps={steps}
      finishLabel="Create syllabus"
      finishIcon={Plus}
      dirty={start !== null || text !== '' || name !== ''}
      onClose={onCancel}
      onFinish={() => void finish()}
    />
  );
}

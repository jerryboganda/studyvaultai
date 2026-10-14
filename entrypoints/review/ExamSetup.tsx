import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Clock,
  Folder,
  Gauge,
  Infinity as NoLimit,
  Layers,
  Library,
  ListOrdered,
  ListTree,
  Pencil,
  Play,
  Shuffle,
  SquarePlus,
  Tag,
  Timer,
  type LucideIcon,
} from 'lucide-react';
import { coverageTopics } from '@study/analytics';
import {
  EXAM_MAX_MINUTES,
  EXAM_MAX_QUESTIONS,
  examDuration,
  examScopeOptions,
  validateExamConfig,
  type ExamConfig,
  type ExamHistoryEntry,
  type ExamScope,
  type ExamSession,
} from '@study/exam';
import {
  SKIP_REASON_TEXT,
  drawSyllabusExam,
  syllabusExamCounts,
  syllabusExamPool,
  syllabusScopeLabel,
} from '@study/examSyllabus';
import { loadExamTopicRefs, type ExamData } from '@storage/exam';
import {
  BuddyEmptyState,
  Button,
  ChoiceCards,
  ChunkyButton,
  InfoTip,
  InlineNotice,
  Wizard,
  plural,
  useAction,
  useAsync,
  useDataEpoch,
  type ArtTone,
  type Choice,
  type WizardStep,
} from '@ui';
import { TID, formatWhen, percent, type ExamTarget } from '@ui/review';
import { openDashboard, type DashboardTarget } from '@ui/vault/dashboardLink';
import { Loading } from './StudyView';

const whole = (text: string): number => (/^\d+$/.test(text.trim()) ? Number(text) : Number.NaN);

const SCOPE_ART: Record<ExamScope['kind'], { icon: LucideIcon; tone: ArtTone }> = {
  all: { icon: Layers, tone: 'sun' },
  bank: { icon: Library, tone: 'primary' },
  folder: { icon: Folder, tone: 'success' },
  tag: { icon: Tag, tone: 'violet' },
  syllabus: { icon: ListTree, tone: 'violet' },
};

/** "Bank: Cardiology" -> "Cardiology" (the kind is shown as the card's art and meta line). */
const scopeName = (label: string): string => label.replace(/^(Bank|Folder|Tag): /, '');

/** What the first library step picks: everything, or one bank, folder or tag (the next step). */
type LibraryKind = 'all' | 'bank' | 'folder' | 'tag';
const KIND_WORD = { bank: 'bank', folder: 'folder', tag: 'tag' } as const;

type CountChoice = 'all' | 'custom' | `${number}`;
type TimeChoice = 'none' | 'pace' | 'custom';

function Summary({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
}) {
  return (
    <li className="rv-review-row">
      <span className="rv-review-row__icon sv-art--primary" aria-hidden="true">
        <Icon strokeWidth={2.4} />
      </span>
      <span className="rv-review-row__text">
        <span className="rv-review-row__label">{label}</span>
        <strong>{children}</strong>
      </span>
    </li>
  );
}

/**
 * Exam setup as a wizard (UX_DESIGN section 10): where to ask from, the scope, how many questions,
 * the time limit, then a last look with the plan. An exam in progress is offered instead of the
 * wizard; recent exams are listed below it. Everything shown is derived from the real cards.
 */
export function ExamSetup({
  data,
  loading,
  loadError,
  retry,
  current,
  target,
  history,
  historyError,
  busy,
  startError,
  timeZone,
  onStart,
  onContinue,
  onShowResults,
  onDiscard,
  onClearHistory,
  onCreateCards,
}: {
  data: ExamData | null;
  loading: boolean;
  loadError: string | null;
  retry(): void;
  /** The exam kept on this device: in progress, or finished with its results still open. */
  current: ExamSession | null;
  /** A syllabus (and topic) to start from: the form opens on it. */
  target: ExamTarget | null;
  history: readonly ExamHistoryEntry[];
  historyError: string | null;
  busy: boolean;
  startError: string | null;
  timeZone: string;
  onStart(config: ExamConfig): void;
  onContinue(): void;
  onShowResults(): void;
  onDiscard(): void;
  onClearHistory(): void;
  /** The empty state's action: open the Create tab. */
  onCreateCards?(): void;
}) {
  const uid = useId();
  const epoch = useDataEpoch();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const options = useMemo(() => (data ? examScopeOptions(data) : []), [data]);
  const syllabi = data?.syllabi ?? [];
  const [scopeKind, setScopeKind] = useState<LibraryKind>('all');
  const [scopeValue, setScopeValue] = useState('all');
  const [source, setSource] = useState<'library' | 'syllabus'>(target ? 'syllabus' : 'library');
  const [syllabusId, setSyllabusId] = useState<string | null>(target?.syllabusId ?? null);
  const [topicId, setTopicId] = useState<string | null>(target?.topicId ?? null);
  const [weighted, setWeighted] = useState(false);
  const [countChoice, setCountChoice] = useState<CountChoice | null>(null);
  const [questionsText, setQuestionsText] = useState('');
  const [timeChoice, setTimeChoice] = useState<TimeChoice>('none');
  const [minutesText, setMinutesText] = useState<string | null>(null);
  const [shuffle, setShuffle] = useState(true);
  // One seed per form: the plan shown for a syllabus exam is the one that gets drawn.
  const [seed] = useState(() => Math.floor(Math.random() * 0x100000000));
  const openEditor = useAction(async (to: DashboardTarget) => {
    await openDashboard(to);
  });

  // The syllabus scope is only read when it is in use (it reads the filing of every card).
  const bySyllabus = source === 'syllabus' && syllabi.length > 0;
  const refs = useAsync(
    () => (bySyllabus ? loadExamTopicRefs() : Promise.resolve(null)),
    [bySyllabus],
    [epoch],
  );
  const syllabus = bySyllabus
    ? (syllabi.find((s) => s.id === syllabusId) ?? syllabi[0])
    : undefined;
  const topics = useMemo(() => (syllabus ? coverageTopics(syllabus.nodes) : []), [syllabus]);
  const topic = topicId === null ? null : (topics.find((t) => t.id === topicId) ?? null);
  const refsData = refs.data ?? null;
  const input = useMemo(
    () => (refsData === null ? null : { topics, refs: refsData }),
    [topics, refsData],
  );
  const counts = useMemo(
    () => (input && data && bySyllabus ? syllabusExamCounts(input, data.cards) : null),
    [input, data, bySyllabus],
  );
  const pool = useMemo(
    () =>
      input && data && bySyllabus
        ? syllabusExamPool({
            syllabus: input,
            topicId: topic?.id ?? null,
            weighted,
            cards: data.cards,
            seed,
          })
        : null,
    [input, data, bySyllabus, topic?.id, weighted, seed],
  );

  // A pick from another kind is kept (Back restores it) but only counts under its own kind.
  const option =
    scopeKind === 'all'
      ? options[0]
      : options.find((o) => o.value === scopeValue && o.scope.kind === scopeKind);
  const available = bySyllabus ? (pool?.drawable ?? 0) : (option?.available ?? 0);
  const inProgress = current !== null && current.phase !== 'finished';

  // Number of questions: a few round presets below what can be asked, everything, or a typed number.
  const most = Math.min(available, EXAM_MAX_QUESTIONS);
  const presets = [10, 20, 50, 100].filter((n) => n < most);
  const fallback: CountChoice = presets.includes(20) ? '20' : 'all';
  const count: CountChoice =
    countChoice === 'all' ||
    countChoice === 'custom' ||
    (countChoice !== null && presets.includes(Number(countChoice)))
      ? countChoice
      : fallback;
  const questions =
    count === 'all' ? most : count === 'custom' ? whole(questionsText) : Number(count);
  const asked = Number.isFinite(questions) ? Math.min(questions, available) : available;
  const pace = Math.min(EXAM_MAX_MINUTES, Math.max(1, asked));
  const minutes =
    timeChoice === 'none'
      ? null
      : timeChoice === 'pace'
        ? pace
        : whole(minutesText ?? String(pace));
  const check = validateExamConfig({ questions, minutes }, available);
  const wanted = check.ok ? check.count : null;
  const draw = useMemo(
    () => (pool && wanted !== null ? drawSyllabusExam(pool, wanted) : null),
    [pool, wanted],
  );

  const readingSyllabus = bySyllabus && !refs.error && refsData === null;

  // A page opened on a syllabus puts the person at the form's heading.
  const ready = data !== null && !loading && loadError === null;
  useEffect(() => {
    if (target && ready) headingRef.current?.focus();
  }, [target, ready]);

  if (loadError) {
    return (
      <InlineNotice
        tone="error"
        title="Your cards could not be loaded"
        action={<Button onClick={retry}>Retry</Button>}
      >
        {loadError}
      </InlineNotice>
    );
  }
  if (loading || !data) return <Loading label="Loading your cards…" />;

  const picked: { scope: ExamScope; label: string } | null = bySyllabus
    ? syllabus
      ? {
          scope: {
            kind: 'syllabus',
            syllabusId: syllabus.id,
            topicId: topic?.id ?? null,
            weighted,
          },
          label: syllabusScopeLabel(syllabus.name, topic?.title ?? null, weighted),
        }
      : null
    : option
      ? { scope: option.scope, label: option.label }
      : null;

  const scopeProblem = (): string | null => {
    if (readingSyllabus) return 'Reading your syllabus and cards…';
    if (bySyllabus && refs.error) return 'Your syllabus could not be read.';
    if (bySyllabus && topics.length === 0) return 'This syllabus has no topics yet.';
    if (bySyllabus && pool && pool.inScope === 0) return 'No card belongs to this topic yet.';
    if (!bySyllabus && scopeKind !== 'all' && !option) return `Pick a ${KIND_WORD[scopeKind]}.`;
    if (available < 1) return 'There are no cards to ask in this scope.';
    return null;
  };
  const finalProblem = (): string | null => {
    const scope = scopeProblem();
    if (scope !== null) return scope;
    if (!check.ok) return check.errors.questions ?? check.errors.minutes ?? null;
    if (inProgress) return 'Finish or discard the exam in progress first.';
    return busy ? 'Starting the exam…' : null;
  };

  const start = () => {
    if (!picked || !check.ok || finalProblem() !== null) return;
    onStart({
      scope: picked.scope,
      scopeLabel: picked.label,
      questions: check.count,
      minutes,
      shuffle,
      ...(bySyllabus ? { seed } : {}),
    });
  };

  const goneNote =
    target !== null && source === 'syllabus'
      ? syllabi.length === 0
        ? 'The syllabus this exam was to be made from has been deleted.'
        : !syllabi.some((s) => s.id === target.syllabusId)
          ? 'The syllabus you chose has been deleted. Pick another one.'
          : target.topicId !== null && syllabusId === target.syllabusId && topic === null
            ? 'The topic you chose is no longer in this syllabus. The whole syllabus is used.'
            : null
      : null;

  const editSyllabus = (id?: string) =>
    void openEditor.run(id ? { view: 'syllabus', syllabus: id } : { view: 'syllabus' });

  const kinds = (['bank', 'folder', 'tag'] as const).filter((k) =>
    options.some((o) => o.scope.kind === k),
  );
  const kindChoices: Choice<LibraryKind>[] = [
    {
      value: 'all',
      label: 'All cards',
      hint: plural(options[0]?.available ?? 0, 'card'),
      icon: SCOPE_ART.all.icon,
      tone: SCOPE_ART.all.tone,
    },
    ...kinds.map((k) => ({
      value: k,
      label: `A ${KIND_WORD[k]}`,
      hint: plural(options.filter((o) => o.scope.kind === k).length, KIND_WORD[k]),
      icon: SCOPE_ART[k].icon,
      tone: SCOPE_ART[k].tone,
    })),
  ];
  const scopeChoices: Choice<string>[] = options
    .filter((o) => o.scope.kind === scopeKind)
    .map((o) => {
      // A folder shows its own name; its bank and parent folders go to the meta line.
      const path = scopeName(o.label).split(' / ');
      const parent = path.length > 1 ? `${path.slice(0, -1).join(' / ')} · ` : '';
      return {
        value: o.value,
        label: path.at(-1) ?? o.label,
        hint: `${parent}${plural(o.available, 'card')}`,
        icon: SCOPE_ART[o.scope.kind].icon,
        tone: SCOPE_ART[o.scope.kind].tone,
      };
    });

  const libraryScope = (
    <>
      <div data-testid={TID.examScope}>
        <ChoiceCards<LibraryKind>
          label="What to ask"
          options={kindChoices}
          value={scopeKind}
          onChange={setScopeKind}
          columns={kindChoices.length > 2 ? 4 : 2}
        />
      </div>
      {syllabi.length === 0 ? (
        <p className="rv-wizline" data-testid={TID.examSyllabusNone}>
          By topic of a course?
          <InfoTip label="About syllabus exams" align="start">
            Make a syllabus first: an outline whose topics point at your banks and tags.
          </InfoTip>
          <Button variant="ghost" onClick={() => editSyllabus()} data-testid={TID.examSyllabusEdit}>
            Create a syllabus
          </Button>
        </p>
      ) : null}
    </>
  );

  const syllabusScope = syllabus ? (
    <div className="rv-wizstack">
      {syllabi.length > 1 ? (
        <div className="sv-field">
          <label className="sv-label" htmlFor={`${uid}-syl`}>
            Syllabus
          </label>
          <select
            id={`${uid}-syl`}
            className="sv-control"
            data-testid={TID.examSyllabus}
            value={syllabus.id}
            onChange={(e) => {
              setSyllabusId(e.target.value);
              setTopicId(null);
            }}
          >
            {syllabi.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="rv-wizline">
          <ListTree aria-hidden="true" strokeWidth={2.5} />
          <strong data-testid={TID.examSyllabus}>{syllabus.name}</strong>
        </p>
      )}

      {topics.length === 0 ? (
        <BuddyEmptyState
          pose="think"
          title="No topics yet"
          text="Add topics in the syllabus editor."
          mascotSize={96}
          action={{
            label: 'Edit this syllabus',
            icon: Pencil,
            onClick: () => editSyllabus(syllabus.id),
          }}
        />
      ) : (
        <>
          <div className="sv-field">
            <label className="sv-label" htmlFor={`${uid}-topic`}>
              Topic (and below)
            </label>
            <select
              id={`${uid}-topic`}
              className="sv-control"
              data-testid={TID.examTopic}
              value={topic?.id ?? ''}
              onChange={(e) => setTopicId(e.target.value === '' ? null : e.target.value)}
            >
              <option value="">
                {`The whole syllabus${counts ? ` (${plural(counts.total, 'card')})` : ''}`}
              </option>
              {topics.map((t) => (
                <option key={t.id} value={t.id}>
                  {`${' '.repeat(t.depth - 1)}${t.title}${
                    counts ? ` (${plural(counts.byTopic.get(t.id) ?? 0, 'card')})` : ''
                  }`}
                </option>
              ))}
            </select>
          </div>

          <span className="rv-switchrow">
            <label className="sv-check">
              <input
                type="checkbox"
                role="switch"
                className="sv-switch"
                data-testid={TID.examWeighted}
                checked={weighted}
                onChange={(e) => setWeighted(e.target.checked)}
              />
              <span>Weight by topic</span>
            </label>
            <InfoTip label="About weighting" align="start">
              Questions are shared between the lowest-level topics in proportion to their weights
              (no weight counts as 1). A topic with no cards is left out.
            </InfoTip>
          </span>

          {pool && pool.inScope === 0 ? (
            <BuddyEmptyState
              pose="sleep"
              title="No cards here"
              text="Map a bank or tag to this topic."
              mascotSize={96}
              action={{
                label: 'Edit this syllabus',
                icon: Pencil,
                onClick: () => editSyllabus(syllabus.id),
              }}
            />
          ) : pool ? (
            <p className="rv-wizline" data-testid={TID.examSyllabusNote}>
              {plural(pool.inScope, 'card')} belong to{' '}
              {topic ? `“${topic.title}” and its subtopics` : 'this syllabus'}
              {weighted && pool.inScope > pool.drawable
                ? `; ${plural(
                    pool.inScope - pool.drawable,
                    'card',
                  )} only belong to a topic that has subtopics and are not drawn in a weighted exam`
                : ''}
              .
            </p>
          ) : null}
        </>
      )}
      {refs.error ? (
        <InlineNotice
          tone="error"
          title="Your syllabus cards could not be read"
          action={refs.retryable ? <Button onClick={refs.refresh}>Retry</Button> : undefined}
        >
          {refs.error}
        </InlineNotice>
      ) : null}
    </div>
  ) : null;

  const countChoices: Choice<CountChoice>[] = [
    ...presets.map((n) => ({
      value: String(n) as CountChoice,
      label: String(n),
      hint: 'questions',
      icon: ListOrdered,
      tone: 'primary' as const,
    })),
    {
      value: 'all',
      label: available > EXAM_MAX_QUESTIONS ? String(most) : 'All',
      hint: available > EXAM_MAX_QUESTIONS ? 'The most' : plural(available, 'card'),
      icon: Layers,
      tone: 'sun',
    },
    {
      value: 'custom',
      label: 'Custom',
      hint: `1 to ${EXAM_MAX_QUESTIONS}`,
      icon: Pencil,
      tone: 'violet',
    },
  ];

  const timeChoices: Choice<TimeChoice>[] = [
    { value: 'none', label: 'No limit', hint: 'Finish any time', icon: NoLimit, tone: 'success' },
    { value: 'pace', label: '1 min each', hint: `${pace} min`, icon: Gauge, tone: 'primary' },
    {
      value: 'custom',
      label: 'Custom',
      hint: `1 to ${EXAM_MAX_MINUTES} min`,
      icon: Clock,
      tone: 'violet',
    },
  ];

  const steps: WizardStep[] = [];
  // Opened on a syllabus topic ("Exam on this topic"): that question is already answered.
  if (syllabi.length > 0 && target === null) {
    steps.push({
      id: 'source',
      title: 'Ask from',
      content: (
        <div data-testid={TID.examSource}>
          <ChoiceCards<'library' | 'syllabus'>
            label="Ask from"
            columns={2}
            value={bySyllabus ? 'syllabus' : 'library'}
            onChange={setSource}
            options={[
              {
                value: 'library',
                label: 'My banks',
                hint: 'Banks, folders, tags',
                icon: Library,
                tone: 'primary',
              },
              {
                value: 'syllabus',
                label: 'A syllabus',
                hint: 'Topics of an outline',
                icon: ListTree,
                tone: 'violet',
              },
            ]}
          />
        </div>
      ),
    });
  }
  steps.push({
    id: 'scope',
    title: bySyllabus ? 'Which topic?' : 'What to ask',
    validate: bySyllabus || scopeKind === 'all' ? scopeProblem : undefined,
    content: bySyllabus ? syllabusScope : libraryScope,
  });
  if (!bySyllabus && scopeKind !== 'all') {
    steps.push({
      id: 'pick',
      title: `Which ${KIND_WORD[scopeKind]}?`,
      validate: scopeProblem,
      content: ({ error, errorId }) => (
        <ChoiceCards
          label={`Which ${KIND_WORD[scopeKind]}`}
          options={scopeChoices}
          value={option?.value ?? null}
          onChange={setScopeValue}
          columns={3}
          invalid={error !== null}
          describedBy={error ? errorId : undefined}
        />
      ),
    });
  }
  steps.push({
    id: 'count',
    title: 'How many?',
    validate: () => (check.ok ? null : (check.errors.questions ?? null)),
    content: ({ error, errorId }) => (
      <div className="rv-wizstack">
        <ChoiceCards<CountChoice>
          label="Number of questions"
          options={countChoices}
          value={count}
          columns={4}
          onChange={(v) => {
            setCountChoice(v);
            if (v === 'custom' && questionsText === '')
              setQuestionsText(String(Math.max(1, asked)));
          }}
        />
        {count === 'custom' ? (
          <div className="sv-field rv-wizfield">
            <label className="sv-label" htmlFor={`${uid}-n`}>
              Questions
            </label>
            <input
              id={`${uid}-n`}
              className="sv-control"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              data-testid={TID.examQuestions}
              value={questionsText}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => setQuestionsText(e.target.value)}
            />
          </div>
        ) : null}
        {check.ok && check.capped ? (
          <p className="rv-wizline">
            Only {plural(available, 'card')} can be asked in this scope, so the exam has{' '}
            {check.count} questions.
          </p>
        ) : null}
        <span className="rv-switchrow">
          <label className="sv-check">
            <input
              type="checkbox"
              role="switch"
              className="sv-switch"
              data-testid={TID.examShuffle}
              checked={shuffle}
              onChange={(e) => setShuffle(e.target.checked)}
            />
            <span>Shuffle order</span>
          </label>
          <Shuffle aria-hidden="true" className="rv-icon" strokeWidth={2.5} />
        </span>
      </div>
    ),
  });
  steps.push({
    id: 'time',
    title: 'Time limit',
    validate: () => (check.ok ? null : (check.errors.minutes ?? null)),
    content: ({ error, errorId }) => (
      <div className="rv-wizstack">
        <ChoiceCards<TimeChoice>
          label="Time limit"
          options={timeChoices}
          value={timeChoice}
          columns={3}
          onChange={setTimeChoice}
        />
        {timeChoice === 'custom' ? (
          <div className="sv-field rv-wizfield">
            <label className="sv-label" htmlFor={`${uid}-m`}>
              Minutes
            </label>
            <input
              id={`${uid}-m`}
              className="sv-control"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              data-testid={TID.examMinutes}
              value={minutesText ?? String(pace)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => setMinutesText(e.target.value)}
            />
          </div>
        ) : null}
        <p className="rv-wizline">
          {timeChoice === 'none'
            ? 'The exam ends when you finish it.'
            : 'The clock cannot be paused.'}
          {timeChoice !== 'none' ? (
            <InfoTip label="About the clock" align="start">
              It covers answering; marking your own answers afterwards is not timed.
            </InfoTip>
          ) : null}
        </p>
      </div>
    ),
  });
  steps.push({
    id: 'plan',
    title: 'Looks good?',
    validate: finalProblem,
    content: (
      <div className="rv-wizstack">
        <ul className="rv-review-list">
          <Summary icon={bySyllabus ? ListTree : Library} label="Ask from">
            {picked?.label ?? 'Nothing chosen'}
          </Summary>
          <Summary icon={ListOrdered} label="Questions">
            {wanted ?? '?'} {shuffle ? '· shuffled' : '· in order'}
          </Summary>
          <Summary icon={Timer} label="Time">
            {minutes === null ? 'No limit' : `${minutes} min`}
          </Summary>
        </ul>
        {draw && pool && pool.inScope > 0 ? (
          <details className="rv-details" data-testid={TID.examPlan}>
            <summary>
              {weighted
                ? `How the ${plural(draw.picked.length, 'question')} are shared between topics`
                : `Lowest-level topics of this scope (${draw.rows.length})`}
            </summary>
            <div className="rv-details__body sv-stack sv-stack--tight">
              <div className="rv-tablewrap" role="region" aria-label="Topics" tabIndex={0}>
                <table className="rv-table">
                  <caption className="sv-sr">
                    {weighted
                      ? 'Questions per lowest-level topic, by weight'
                      : 'Cards per lowest-level topic'}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Topic</th>
                      {weighted ? <th scope="col">Share</th> : null}
                      <th scope="col">Cards</th>
                      {weighted ? <th scope="col">Questions</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {draw.rows.map((r) => (
                      <tr key={r.topicId}>
                        <th scope="row">{r.title}</th>
                        {weighted ? <td>{percent(r.share, 1)}</td> : null}
                        <td>{r.available}</td>
                        {weighted ? <td>{r.asked}</td> : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {draw.skipped.length > 0 ? (
                <p className="sv-small" data-testid={TID.examLeftOut}>
                  Left out:{' '}
                  {draw.skipped.map((s) => `${s.title} (${SKIP_REASON_TEXT[s.reason]})`).join('; ')}
                  .
                </p>
              ) : null}
              <p className="sv-small sv-muted">
                A card that belongs to several topics is counted under one of them, so the questions
                add up.
              </p>
            </div>
          </details>
        ) : null}
      </div>
    ),
  });

  return (
    <div className="rv-exam" data-testid={TID.examSetup}>
      <header className="rv-tabhead">
        <span className="rv-tabhead__art sv-art--violet" aria-hidden="true">
          <Timer strokeWidth={2.4} />
        </span>
        <div className="rv-tabhead__text">
          <h2 ref={headingRef} tabIndex={-1} className="rv-tabhead__title">
            Practice exam
          </h2>
          <p className="rv-tabhead__line">
            No feedback until the end
            <InfoTip label="About exams" align="start">
              A timed run with no feedback until the end. An exam never changes your review schedule
              unless you count it as review on the results page.
            </InfoTip>
          </p>
        </div>
      </header>

      {current ? (
        <section
          className={`rv-resume${inProgress ? '' : ' rv-resume--quiet'}`}
          aria-labelledby={`${uid}-cur`}
        >
          <span
            className={`rv-resume__art sv-art--${inProgress ? 'sun' : 'success'}`}
            aria-hidden="true"
          >
            {inProgress ? <Play strokeWidth={2.4} /> : <ListOrdered strokeWidth={2.4} />}
          </span>
          <div className="rv-resume__body">
            <h3 id={`${uid}-cur`} className="rv-resume__title">
              {inProgress ? 'Exam in progress' : 'Last results'}
            </h3>
            <p className="rv-resume__line">
              {current.scopeLabel} · {plural(current.questions.length, 'question')}
              <InfoTip
                label={inProgress ? 'About the exam in progress' : 'About these results'}
                align="start"
              >
                {inProgress
                  ? 'The timer does not pause while you are away.'
                  : 'They are kept on this device for 24 hours.'}
              </InfoTip>
            </p>
          </div>
          <div className="rv-resume__actions">
            <ChunkyButton
              variant="primary"
              data-testid={TID.examContinue}
              onClick={inProgress ? onContinue : onShowResults}
            >
              {inProgress ? 'Continue exam' : 'Show results'}
            </ChunkyButton>
            <Button variant="ghost" data-testid={TID.examDiscard} onClick={onDiscard}>
              {inProgress ? 'Discard exam' : 'Close results'}
            </Button>
          </div>
        </section>
      ) : null}

      {options[0]?.available === 0 ? (
        <BuddyEmptyState
          pose="sleep"
          title="No cards yet"
          text="Make flashcards first."
          heading="h3"
          {...(onCreateCards
            ? { action: { label: 'Create cards', icon: SquarePlus, onClick: onCreateCards } }
            : {})}
        />
      ) : inProgress ? null : (
        <>
          {goneNote ? <InlineNotice tone="warning">{goneNote}</InlineNotice> : null}
          {openEditor.error ? (
            <InlineNotice tone="error" title="Could not open the dashboard">
              {openEditor.error}
            </InlineNotice>
          ) : null}
          <Wizard
            label="New exam"
            steps={steps}
            onFinish={start}
            finishLabel="Start exam"
            finishIcon={Play}
            className="rv-wizard"
          />
          {startError ? <InlineNotice tone="error">{startError}</InlineNotice> : null}
        </>
      )}

      <section className="rv-history" aria-labelledby={`${uid}-hist`} data-testid={TID.examHistory}>
        <h2 id={`${uid}-hist`} className="rv-sechead">
          Recent exams
          <InfoTip label="Where exams are kept" align="start">
            This list and an exam in progress are stored on this device only. They are not part of
            backups and are not synced, and “Delete all data” removes them.
          </InfoTip>
        </h2>
        {historyError ? <InlineNotice tone="error">{historyError}</InlineNotice> : null}
        {history.length === 0 ? (
          <p className="sv-muted">No exam has been finished yet.</p>
        ) : (
          <>
            <div className="rv-tablewrap" role="region" aria-label="Recent exams" tabIndex={0}>
              <table className="rv-table rv-table--cards">
                <caption className="sv-sr">The last {history.length} exams you finished</caption>
                <thead>
                  <tr>
                    <th scope="col">Finished</th>
                    <th scope="col">Scope</th>
                    <th scope="col">Score</th>
                    <th scope="col">Time</th>
                    <th scope="col">Counted as review</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => {
                    const graded = h.total - h.void;
                    return (
                      <tr key={h.id}>
                        <th scope="row">{formatWhen(h.finishedAt, timeZone)}</th>
                        <td>{h.scopeLabel}</td>
                        <td>
                          <span className="rv-scorecell">
                            {graded > 0 ? (
                              <span className="rv-bars__track" aria-hidden="true">
                                <span
                                  className="rv-bars__fill rv-bars__fill--success"
                                  style={{ width: `${Math.round((h.correct / graded) * 100)}%` }}
                                />
                              </span>
                            ) : null}
                            <span>
                              {graded === 0 ? 'n/a' : percent(h.correct / graded)} ({h.correct} of{' '}
                              {graded})
                            </span>
                          </span>
                        </td>
                        <td>
                          {examDuration(h.usedMs)}
                          {h.minutes === null
                            ? ''
                            : h.timedOut
                              ? `, ran out (limit ${h.minutes} min)`
                              : ` of ${h.minutes} min`}
                        </td>
                        <td>{h.countedAsReview ? 'Yes' : 'No'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="sv-row">
              <Button variant="ghost" data-testid={TID.examHistoryClear} onClick={onClearHistory}>
                Clear this list
              </Button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

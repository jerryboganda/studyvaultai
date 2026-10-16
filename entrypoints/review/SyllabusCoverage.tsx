import { useId, useMemo, useState } from 'react';
import {
  Check,
  CircleDashed,
  CircleDot,
  ListTree,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Timer,
  Unlink,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { flattenSyllabus, type Syllabus } from '@shared';
import {
  DEFAULT_COVERAGE_THRESHOLDS,
  MAX_COVERAGE_THRESHOLD,
  MIN_TOPIC_RETENTION_REVIEWS,
  coverageTopics,
  syllabusTopicCoverage,
  type CoverageThresholds,
  type CoverageState,
  type TopicCoverage,
} from '@study/analytics';
import { listSyllabi } from '@storage';
import {
  loadCoverageThresholds,
  loadSyllabusCoverageData,
  saveCoverageThresholds,
} from '@storage/syllabusCoverage';
import {
  Button,
  ChunkyButton,
  InfoTip,
  InlineNotice,
  ProgressRing,
  plural,
  useAction,
  useAsync,
  useDataEpoch,
} from '@ui';
import {
  TID,
  clockKey,
  formatWhen,
  percent,
  syllabusExamId,
  syllabusRowId,
  syllabusShowId,
  syllabusSortId,
  toClock,
  type ExamTarget,
  type StudySettings,
} from '@ui/review';
import { openDashboard, type DashboardTarget } from '@ui/vault/dashboardLink';
import { subtreeMappings, topicLibraryTarget, type TopicLibraryTarget } from '@ui/vault/topicLink';
import { Disclosure, Empty, Loading, Panel, Pill } from './ManageKit';

/**
 * Coverage of a custom syllabus (ADR-020 part 2): per topic, what the vault holds and how well it is
 * known. The table is the primary view and the chart a picture of it. Every number is derived from
 * the person's own highlights, cards and reviews by `syllabusTopicCoverage`; nothing is estimated
 * where it cannot be (a topic with too few reviews shows no retention).
 */

const STATE_TEXT: Record<
  CoverageState,
  { icon: LucideIcon; label: string; tone: 'success' | 'warning' | undefined }
> = {
  covered: { icon: Check, label: 'Covered', tone: 'success' },
  thin: { icon: CircleDot, label: 'Thin', tone: 'warning' },
  none: { icon: CircleDashed, label: 'None', tone: undefined },
};
const STATE_RANK: Record<CoverageState, number> = { none: 0, thin: 1, covered: 2 };

type SortKey = 'title' | 'share' | 'highlights' | 'cards' | 'due' | 'retention' | 'last' | 'state';
interface Sort {
  key: SortKey;
  dir: 'asc' | 'desc';
}

const COLUMNS: Array<{ key: SortKey; label: string; numeric: boolean }> = [
  { key: 'title', label: 'Topic', numeric: false },
  { key: 'share', label: 'Share', numeric: true },
  { key: 'highlights', label: 'Highlights', numeric: true },
  { key: 'cards', label: 'Cards', numeric: true },
  { key: 'due', label: 'Due', numeric: true },
  { key: 'retention', label: 'Retention', numeric: true },
  { key: 'last', label: 'Last studied', numeric: false },
  { key: 'state', label: 'Coverage', numeric: false },
];

function sortValue(t: TopicCoverage, key: SortKey): number | string {
  switch (key) {
    case 'title':
      return t.title.toLocaleLowerCase();
    case 'share':
      return t.share;
    case 'highlights':
      return t.highlights;
    case 'cards':
      return t.cards;
    case 'due':
      return t.due;
    case 'retention':
      return t.retention.value ?? -1;
    case 'last':
      return t.lastStudiedAt === null ? 0 : Date.parse(t.lastStudiedAt);
    case 'state':
      return STATE_RANK[t.state] + t.covered / 2;
  }
}

/** A threshold typed by the person: a whole number from 0 to 999. */
function parseThreshold(
  text: string,
): { ok: true; value: number } | { ok: false; message: string } {
  const t = text.trim();
  const message = `Use a whole number from 0 to ${MAX_COVERAGE_THRESHOLD}.`;
  if (!/^\d{1,3}$/.test(t)) return { ok: false, message };
  const value = Number(t);
  return value <= MAX_COVERAGE_THRESHOLD ? { ok: true, value } : { ok: false, message };
}

const pct = (share: number): number => Math.round(share * 100);

export default function SyllabusCoverage({
  settings,
  onExamOnTopic,
}: {
  settings: StudySettings;
  /** Opens the exam setup on a topic. Without it (a host that has no exam) the button is absent. */
  onExamOnTopic?: ((target: ExamTarget) => void) | undefined;
}) {
  const epoch = useDataEpoch();
  const key = clockKey(settings);
  const selectId = useId();
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort | null>(null);

  const model = useAsync(
    async () => {
      const syllabi = await listSyllabi();
      if (syllabi.length === 0) return { syllabi, data: null, thresholds: null };
      const [data, thresholds] = await Promise.all([
        loadSyllabusCoverageData({ boundary: toClock(settings).boundary }),
        loadCoverageThresholds(),
      ]);
      return { syllabi, data, thresholds };
    },
    [key],
    [epoch],
  );

  // What the person typed into the thresholds, until it is saved.
  const [saved, setSaved] = useState<CoverageThresholds | null>(null);
  const [minHighlights, setMinHighlights] = useState('');
  const [minCards, setMinCards] = useState('');
  const [thresholdStatus, setThresholdStatus] = useState('');
  const stored = model.data?.thresholds ?? null;
  const storedHighlights = stored?.minHighlights;
  const storedCards = stored?.minCards;
  // Follow the stored values when they change (not on every refresh: typing is not interrupted).
  const storedKey =
    storedHighlights === undefined ? '' : `${storedHighlights}:${storedCards ?? ''}`;
  const [seenKey, setSeenKey] = useState('');
  if (storedKey !== '' && storedKey !== seenKey) {
    setSeenKey(storedKey);
    setSaved({ minHighlights: storedHighlights ?? 0, minCards: storedCards ?? 0 });
    setMinHighlights(String(storedHighlights));
    setMinCards(String(storedCards));
  }

  const thresholds = saved ?? stored ?? DEFAULT_COVERAGE_THRESHOLDS;
  const syllabi = model.data?.syllabi ?? [];
  const syllabus: Syllabus | null = syllabi.find((s) => s.id === pickedId) ?? syllabi[0] ?? null;
  const data = model.data?.data ?? null;

  const open = useAction(async (target: DashboardTarget) => {
    await openDashboard(target);
  });
  const persist = useAction(async (next: CoverageThresholds) => {
    const value = await saveCoverageThresholds(next);
    setSaved(value);
    setThresholdStatus(
      `Saved on this device: covered from ${plural(value.minHighlights, 'highlight')} and ${plural(
        value.minCards,
        'card',
      )}.`,
    );
  });

  const nodes = syllabus?.nodes;
  const flat = useMemo(() => (nodes ? flattenSyllabus(nodes) : []), [nodes]);
  const report = useMemo(() => {
    if (!data || !nodes || flat.length === 0) return null;
    return syllabusTopicCoverage(
      coverageTopics(nodes),
      { highlights: data.highlights, cards: data.cards, logs: data.logs },
      { now: data.now, boundary: data.boundary, thresholds },
    );
  }, [data, nodes, flat, thresholds]);

  const names = useMemo(
    () => ({
      banks: new Map((data?.banks ?? []).map((b) => [b.id, b.name] as const)),
      tags: new Map((data?.tags ?? []).map((t) => [t.id, t.name] as const)),
    }),
    [data],
  );
  const mappings = useMemo(() => subtreeMappings(nodes ?? []), [nodes]);

  if (model.error) {
    return (
      <InlineNotice
        tone="error"
        title="Coverage could not load"
        action={model.retryable ? <Button onClick={model.refresh}>Retry</Button> : undefined}
      >
        {model.error}
      </InlineNotice>
    );
  }
  if (!model.data) return <Loading>Loading coverage…</Loading>;

  if (syllabi.length === 0 || syllabus === null) {
    return (
      <Panel icon={ListTree} tone="violet" title="Syllabus coverage" testId={TID.syllabus}>
        <Empty
          pose="wave"
          title="No syllabus yet"
          line={
            <span data-testid={TID.syllabusEmpty}>
              Outline your exam to see coverage per topic.
            </span>
          }
        >
          <ChunkyButton
            variant="primary"
            icon={Plus}
            onClick={() => void open.run({ view: 'syllabus' })}
            data-testid={TID.syllabusCreate}
          >
            Create syllabus
          </ChunkyButton>
        </Empty>
        {open.error ? <InlineNotice tone="error">{open.error}</InlineNotice> : null}
      </Panel>
    );
  }

  const tz = data?.boundary.timeZone ?? 'UTC';
  const topics = report?.topics ?? [];
  const parentTitle = new Map(topics.map((t) => [t.id, t.title]));
  const rows = sort
    ? [...topics].sort((a, b) => {
        const x = sortValue(a, sort.key);
        const y = sortValue(b, sort.key);
        const order = x < y ? -1 : x > y ? 1 : 0;
        return sort.dir === 'asc' ? order : -order;
      })
    : topics;
  const roots = topics.filter((t) => t.parentId === null);
  const counts = { covered: 0, thin: 0, none: 0 };
  for (const t of roots) counts[t.state] += 1;

  const typedHighlights = parseThreshold(minHighlights);
  const typedCards = parseThreshold(minCards);
  const dirty =
    typedHighlights.ok &&
    typedCards.ok &&
    (typedHighlights.value !== thresholds.minHighlights ||
      typedCards.value !== thresholds.minCards);
  const thresholdError = !typedHighlights.ok
    ? `Highlights needed: ${typedHighlights.message}`
    : !typedCards.ok
      ? `Cards needed: ${typedCards.message}`
      : null;
  const commitThresholds = () => {
    if (!typedHighlights.ok || !typedCards.ok || !dirty) return;
    void persist.run({ minHighlights: typedHighlights.value, minCards: typedCards.value });
  };
  const isDefault =
    thresholds.minHighlights === DEFAULT_COVERAGE_THRESHOLDS.minHighlights &&
    thresholds.minCards === DEFAULT_COVERAGE_THRESHOLDS.minCards;

  const targetOf = (topicId: string): TopicLibraryTarget =>
    topicLibraryTarget(
      mappings.get(topicId) ?? { bankIds: [], tagIds: [] },
      names.banks,
      names.tags,
    );
  const show = (t: TopicLibraryTarget) => {
    if (t.kind === 'none') return;
    void open.run(t.kind === 'bank' ? { bank: t.bankId } : { q: t.q });
  };

  const toggleSort = (k: SortKey) =>
    setSort((s) =>
      s?.key !== k ? { key: k, dir: 'asc' } : s.dir === 'asc' ? { key: k, dir: 'desc' } : null,
    );
  const thresholdInput = (
    which: 'h' | 'c',
    label: string,
    value: string,
    set: (v: string) => void,
    ok: boolean,
    testId: string,
  ) => (
    <div className="sv-field">
      <label className="sv-label" htmlFor={`${selectId}-${which}`}>
        {label}
      </label>
      <input
        id={`${selectId}-${which}`}
        className="sv-control rv-syl-num"
        inputMode="numeric"
        value={value}
        autoComplete="off"
        aria-invalid={!ok || undefined}
        onChange={(e) => set(e.target.value)}
        onBlur={commitThresholds}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commitThresholds();
          }
        }}
        data-testid={testId}
      />
    </div>
  );

  return (
    <Panel
      icon={ListTree}
      tone="violet"
      title="Syllabus coverage"
      testId={TID.syllabus}
      end={
        <>
          {syllabi.length > 1 ? (
            <div className="rvm-unit">
              <label className="sv-vh" htmlFor={selectId}>
                Syllabus
              </label>
              <select
                id={selectId}
                className="sv-control"
                value={syllabus.id}
                onChange={(e) => setPickedId(e.target.value)}
                data-testid={TID.syllabusSelect}
              >
                {syllabi.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <Pill icon={ListTree} tone="violet">
              <span dir="auto">{syllabus.name}</span>
            </Pill>
          )}
          <ChunkyButton
            size="sm"
            icon={Pencil}
            onClick={() => void open.run({ view: 'syllabus', syllabus: syllabus.id })}
            data-testid={TID.syllabusEdit}
          >
            Edit syllabus
          </ChunkyButton>
        </>
      }
    >
      {open.error ? (
        <InlineNotice tone="error" title="Could not open the dashboard">
          <span data-testid={TID.syllabusError}>{open.error}</span>
        </InlineNotice>
      ) : null}

      {report === null || flat.length === 0 ? (
        <Empty title="No topics yet" line="Add topics, then point them at banks and tags." />
      ) : (
        <>
          <div className="rvm-ringrow" data-testid={TID.syllabusOverall}>
            <Ring value={report.covered} label="Covered" tone="success" />
            <Ring value={report.started} label="Started" tone="primary" />
            <div className="rvm-ringrow__text">
              <p className="rvm-line">
                <span className="rv-count">{report.unmapped}</span> of{' '}
                {plural(topics.length, 'topic')} unmapped
              </p>
              <p className="rvm-line">
                Covered from {plural(thresholds.minHighlights, 'highlight')} and{' '}
                {plural(thresholds.minCards, 'card')}
              </p>
            </div>
          </div>

          <ul
            className="rvm-rings"
            data-testid={TID.syllabusChart}
            aria-label={`${plural(roots.length, 'top-level topic')}: ${counts.covered} covered, ${counts.thin} thin, ${counts.none} with no material`}
          >
            {roots.map((t) => {
              const state = STATE_TEXT[t.state];
              return (
                <li key={t.id}>
                  <ProgressRing
                    value={pct(t.covered)}
                    max={100}
                    label={`${t.title} covered`}
                    unit="%"
                    tone="success"
                    size={72}
                    stroke={9}
                  >
                    <span>{pct(t.covered)}%</span>
                  </ProgressRing>
                  <span className="rvm-rings__name" dir="auto">
                    {t.title}
                  </span>
                  <Pill icon={state.icon} tone={state.tone}>
                    {state.label}
                  </Pill>
                </li>
              );
            })}
          </ul>

          <Disclosure
            summary={
              <>
                <SlidersHorizontal aria-hidden="true" width={18} height={18} />
                Coverage rule
              </>
            }
          >
            <fieldset className="rvm-fieldset rv-syl-thresholds">
              <legend>Covered when</legend>
              <div className="rvm-row">
                {thresholdInput(
                  'h',
                  'Highlights needed',
                  minHighlights,
                  setMinHighlights,
                  typedHighlights.ok,
                  TID.syllabusMinHighlights,
                )}
                {thresholdInput(
                  'c',
                  'Cards needed',
                  minCards,
                  setMinCards,
                  typedCards.ok,
                  TID.syllabusMinCards,
                )}
                <Button
                  disabledReason={isDefault ? 'These are already the defaults.' : undefined}
                  onClick={() => {
                    setMinHighlights(String(DEFAULT_COVERAGE_THRESHOLDS.minHighlights));
                    setMinCards(String(DEFAULT_COVERAGE_THRESHOLDS.minCards));
                    void persist.run({ ...DEFAULT_COVERAGE_THRESHOLDS });
                  }}
                  data-testid={TID.syllabusReset}
                >
                  Reset to {DEFAULT_COVERAGE_THRESHOLDS.minHighlights} and{' '}
                  {DEFAULT_COVERAGE_THRESHOLDS.minCards}
                </Button>
              </div>
              {thresholdError ? (
                <p className="rvm-fielderr" role="alert">
                  {thresholdError}
                </p>
              ) : null}
              <p className="rvm-line">
                Fewer is thin; nothing at all is none. Kept on this device.
              </p>
              <p className="rvm-line" role="status" data-testid={TID.syllabusThresholdStatus}>
                {persist.error ?? thresholdStatus}
              </p>
            </fieldset>
          </Disclosure>

          <div className="rvm-card__head">
            <h3>All topics</h3>
            <InfoTip label="About the topic table">
              Highlights and cards count once per topic, with its subtopics; deleted and suspended
              ones do not count. Share comes from the weights; due is today&apos;s reviews plus
              learning steps due now. Retention covers the last 12 months and shows from{' '}
              {MIN_TOPIC_RETENTION_REVIEWS} reviews.
            </InfoTip>
          </div>
          <div className="rv-tablewrap">
            <table className="rv-table rv-syl-table" data-testid={TID.syllabusTable}>
              <caption className="sv-sr">
                Coverage of {syllabus.name} by topic. Use the column buttons to sort.
              </caption>
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th
                      key={c.key}
                      scope="col"
                      aria-sort={
                        sort?.key === c.key
                          ? sort.dir === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : undefined
                      }
                      className={c.numeric ? 'rv-syl-numeric' : undefined}
                    >
                      <button
                        type="button"
                        className="rv-syl-sort"
                        onClick={() => toggleSort(c.key)}
                        data-testid={syllabusSortId(c.key)}
                      >
                        {c.label}
                        <span aria-hidden="true">
                          {sort?.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                        </span>
                      </button>
                    </th>
                  ))}
                  <th scope="col">Highlights list</th>
                  {onExamOnTopic ? <th scope="col">Exam</th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => {
                  const target = targetOf(t.id);
                  const state = STATE_TEXT[t.state];
                  const indent = sort ? 0 : t.depth - 1;
                  const parent = t.parentId === null ? null : parentTitle.get(t.parentId);
                  return (
                    <tr key={t.id} data-testid={syllabusRowId(t.id)}>
                      <th
                        scope="row"
                        className="rv-syl-topic"
                        style={{ paddingInlineStart: `${0.5 + indent * 1.25}rem` }}
                      >
                        <span dir="auto">{t.title}</span>
                        {sort && parent ? (
                          <span className="sv-small sv-muted"> in {parent}</span>
                        ) : null}
                        {!t.subtreeMapped ? (
                          <>
                            {' '}
                            <Pill icon={Unlink}>Not mapped</Pill>
                          </>
                        ) : null}
                      </th>
                      <td className="rv-syl-numeric">{percent(t.share, 1)}</td>
                      <td className="rv-syl-numeric">{t.highlights}</td>
                      <td className="rv-syl-numeric">{t.cards}</td>
                      <td className="rv-syl-numeric">{t.due}</td>
                      <td className="rv-syl-numeric">
                        {t.retention.value === null
                          ? `n/a (${t.retention.reviews})`
                          : `${percent(t.retention.value)} (${t.retention.reviews})`}
                      </td>
                      <td className="rv-syl-when">
                        {t.lastStudiedAt === null ? 'Never' : formatWhen(t.lastStudiedAt, tz)}
                      </td>
                      <td>
                        <Pill icon={state.icon} tone={state.tone}>
                          {state.label}
                        </Pill>
                        {t.scoredFrom === 'subtopics' ? (
                          <span className="sv-small sv-muted">
                            {' '}
                            ({pct(t.covered)}% of its subtopics by weight)
                          </span>
                        ) : null}
                      </td>
                      <td>
                        {target.kind === 'none' && !t.subtreeMapped ? (
                          <Button
                            onClick={() =>
                              void open.run({ view: 'syllabus', syllabus: syllabus.id })
                            }
                            aria-label={`Map a bank or tag to ${t.title}`}
                          >
                            Map
                          </Button>
                        ) : (
                          <Button
                            disabledReason={target.kind === 'none' ? target.reason : undefined}
                            onClick={() => show(target)}
                            aria-label={`Show highlights of ${t.title}`}
                            data-testid={syllabusShowId(t.id)}
                          >
                            <Search aria-hidden="true" width={16} height={16} /> Show
                          </Button>
                        )}
                      </td>
                      {onExamOnTopic ? (
                        <td>
                          <Button
                            disabledReason={
                              t.cards === 0
                                ? 'This topic has no cards to ask yet (suspended and deleted cards are not asked).'
                                : undefined
                            }
                            onClick={() =>
                              onExamOnTopic({ syllabusId: syllabus.id, topicId: t.id })
                            }
                            aria-label={`Exam on this topic: ${t.title}`}
                            data-testid={syllabusExamId(t.id)}
                          >
                            <Timer aria-hidden="true" width={16} height={16} /> Exam
                          </Button>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}

/** Share of the syllabus (0..1) as a ring with the number in its centre and a word under it. */
function Ring({
  value,
  label,
  tone,
}: {
  value: number | null;
  label: string;
  tone: 'success' | 'primary';
}) {
  return (
    <div className="rvm-rings__one">
      {value === null ? (
        // No weight to share out yet: no ring, never a zero.
        <span className="rvm-big">n/a</span>
      ) : (
        <ProgressRing
          value={pct(value)}
          max={100}
          label={`${label} by weight`}
          unit="%"
          tone={tone}
          size={96}
          stroke={11}
        >
          <span className="rv-count">{percent(value)}</span>
        </ProgressRing>
      )}
      <span className="rvm-line">{label}</span>
    </div>
  );
}

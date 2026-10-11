import { useId, useMemo, useState } from 'react';
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
import { Button, EmptyState, InlineNotice, plural, useAction, useAsync, useDataEpoch } from '@ui';
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
import { BarChart } from './Charts';

/**
 * Coverage of a custom syllabus (ADR-020 part 2): per topic, what the vault holds and how well it is
 * known. The table is the primary view and the chart a picture of it. Every number is derived from
 * the person's own highlights, cards and reviews by `syllabusTopicCoverage`; nothing is estimated
 * where it cannot be (a topic with too few reviews shows no retention).
 */

const STATE_TEXT: Record<CoverageState, { glyph: string; label: string }> = {
  covered: { glyph: '✓', label: 'Covered' },
  thin: { glyph: '◐', label: 'Thin' },
  none: { glyph: '–', label: 'None' },
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
        title="Syllabus coverage could not be loaded"
        action={model.retryable ? <Button onClick={model.refresh}>Retry</Button> : undefined}
      >
        {model.error}
      </InlineNotice>
    );
  }
  if (!model.data) return <p className="sv-muted">Loading syllabus coverage…</p>;

  if (syllabi.length === 0 || syllabus === null) {
    return (
      <section className="sv-stack" aria-labelledby="rv-syl-h" data-testid={TID.syllabus}>
        <h2 id="rv-syl-h">Syllabus coverage</h2>
        <EmptyState
          title="You have no syllabus yet"
          action={
            <Button
              onClick={() => void open.run({ view: 'syllabus' })}
              data-testid={TID.syllabusCreate}
            >
              Create a syllabus
            </Button>
          }
        >
          <span data-testid={TID.syllabusEmpty}>
            A syllabus is your own outline of an exam or course. Point its topics at your banks and
            tags and this section shows, per topic, how much you have saved, how many cards are due
            and how well you remember them.
          </span>
        </EmptyState>
        {open.error ? <InlineNotice tone="error">{open.error}</InlineNotice> : null}
      </section>
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
  const bars = roots.map((t, i) => ({
    label: `${i + 1}. ${t.title}`,
    tick: String(i + 1),
    value: pct(t.covered),
    extra: Math.max(0, pct(t.started) - pct(t.covered)),
  }));
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

  return (
    <section className="sv-stack" aria-labelledby="rv-syl-h" data-testid={TID.syllabus}>
      <h2 id="rv-syl-h">Syllabus coverage</h2>

      <div className="sv-row">
        {syllabi.length > 1 ? (
          <div className="sv-field">
            <label className="sv-label" htmlFor={selectId}>
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
          <p className="rv-syl-name">
            <strong dir="auto">{syllabus.name}</strong>
          </p>
        )}
        <Button
          onClick={() => void open.run({ view: 'syllabus', syllabus: syllabus.id })}
          data-testid={TID.syllabusEdit}
        >
          Edit this syllabus
        </Button>
      </div>
      {open.error ? (
        <InlineNotice tone="error" title="Could not open the dashboard">
          <span data-testid={TID.syllabusError}>{open.error}</span>
        </InlineNotice>
      ) : null}

      {report === null || flat.length === 0 ? (
        <EmptyState title="This syllabus has no topics yet">
          Add topics in the editor, then point them at banks and tags.
        </EmptyState>
      ) : (
        <>
          <div className="rv-stats" data-testid={TID.syllabusOverall}>
            <div className="rv-stat">
              <span className="rv-count">{percent(report.covered)}</span>
              <span className="sv-small">
                of the syllabus is covered, by weight (topics with at least{' '}
                {plural(thresholds.minHighlights, 'highlight')} and{' '}
                {plural(thresholds.minCards, 'card')})
              </span>
            </div>
            <div className="rv-stat">
              <span className="rv-count">{percent(report.started)}</span>
              <span className="sv-small">has at least some material (covered or thin)</span>
            </div>
            <div className="rv-stat">
              <span className="rv-count">{report.unmapped}</span>
              <span className="sv-small">
                of {plural(topics.length, 'topic')} point at no bank or tag yet
              </span>
            </div>
          </div>

          <fieldset className="rv-syl-thresholds">
            <legend>When does a topic count as covered?</legend>
            <div className="sv-row">
              <div className="sv-field">
                <label className="sv-label" htmlFor={`${selectId}-h`}>
                  Highlights needed
                </label>
                <input
                  id={`${selectId}-h`}
                  className="sv-control rv-syl-num"
                  inputMode="numeric"
                  value={minHighlights}
                  autoComplete="off"
                  aria-invalid={!typedHighlights.ok || undefined}
                  onChange={(e) => setMinHighlights(e.target.value)}
                  onBlur={commitThresholds}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitThresholds();
                    }
                  }}
                  data-testid={TID.syllabusMinHighlights}
                />
              </div>
              <div className="sv-field">
                <label className="sv-label" htmlFor={`${selectId}-c`}>
                  Cards needed
                </label>
                <input
                  id={`${selectId}-c`}
                  className="sv-control rv-syl-num"
                  inputMode="numeric"
                  value={minCards}
                  autoComplete="off"
                  aria-invalid={!typedCards.ok || undefined}
                  onChange={(e) => setMinCards(e.target.value)}
                  onBlur={commitThresholds}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitThresholds();
                    }
                  }}
                  data-testid={TID.syllabusMinCards}
                />
              </div>
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
              <p className="rv-syl-error sv-small" role="alert">
                {thresholdError}
              </p>
            ) : null}
            <p className="sv-small sv-muted">
              A topic with fewer of either is thin; one with no highlight and no card is none. Your
              choice is kept on this device only.
            </p>
            <p className="sv-small" role="status" data-testid={TID.syllabusThresholdStatus}>
              {persist.error ?? thresholdStatus}
            </p>
          </fieldset>

          <BarChart
            testId={TID.syllabusChart}
            title="Covered share of each top-level topic"
            summary={`${plural(roots.length, 'top-level topic')}: ${counts.covered} covered, ${counts.thin} thin, ${counts.none} with no material. The whole syllabus is ${percent(
              report.covered,
            )} covered by weight. The table below has every topic.`}
            bars={bars}
            valueLabel="Covered, % of the topic"
            extraLabel="Some material but not covered, %"
            categoryLabel="Topic"
            columns={{
              header: 'Share of the syllabus',
              cells: roots.map((t) => percent(t.share, 1)),
            }}
          />

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
                          <span className="sv-small sv-muted">
                            {' '}
                            (map a bank or tag to this topic)
                          </span>
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
                      <td>
                        {t.lastStudiedAt === null ? 'Never' : formatWhen(t.lastStudiedAt, tz)}
                      </td>
                      <td>
                        <span aria-hidden="true">{state.glyph}</span> {state.label}
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
                            Map a bank or tag
                          </Button>
                        ) : (
                          <Button
                            disabledReason={target.kind === 'none' ? target.reason : undefined}
                            onClick={() => show(target)}
                            aria-label={`Show highlights of ${t.title}`}
                            data-testid={syllabusShowId(t.id)}
                          >
                            Show
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
                            Exam on this topic
                          </Button>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="sv-small sv-muted sv-stack sv-stack--tight">
            <p>
              <strong>How to read this.</strong> Highlights and cards are counted once per topic,
              including its subtopics; deleted highlights and deleted or suspended cards are not
              counted. Share is the topic&apos;s part of the syllabus from the weights (equal when
              none is set). Due is review cards due by the end of today plus learning steps due now.
            </p>
            <p>
              Retention is the share of reviews of learned cards, over the last 12 months, that were
              remembered (Hard, Good or Easy), with the number of reviews in brackets; it shows only
              from {MIN_TOPIC_RETENTION_REVIEWS} reviews. A topic with subtopics that point at
              something is judged from them.
            </p>
          </div>
        </>
      )}
    </section>
  );
}

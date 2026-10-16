import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChartColumn,
  Download,
  IndentDecrease,
  IndentIncrease,
  Layers,
  Library,
  ListTree,
  MousePointerClick,
  Pencil,
  Plus,
  Scale,
  Search,
  Tag,
  Trash,
  TriangleAlert,
} from 'lucide-react';
import {
  MAX_SYLLABI,
  MAX_SYLLABUS_DEPTH,
  MAX_SYLLABUS_LINKS,
  MAX_SYLLABUS_NAME_CHARS,
  MAX_SYLLABUS_NODES,
  MAX_SYLLABUS_TITLE_CHARS,
  MAX_SYLLABUS_WEIGHT,
  type Syllabus,
  type SyllabusNode,
} from '@shared';
import {
  checkSyllabi,
  createSyllabus,
  deleteSyllabus,
  getSyllabus,
  listSyllabi,
  restoreSyllabus,
  updateSyllabus,
  type SyllabusNodeInput,
  type SyllabusProblem,
} from '@storage';
import {
  BuddyEmptyState,
  ChunkyButton,
  InfoTip,
  InlineNotice,
  ProgressRing,
  VaultBuddy,
  errorMessage,
  plural,
  useToast,
} from '@ui';
import { reviewPageUrl } from '@ui/review/links';
import {
  PopupMenu,
  Tree,
  subtreeMappings,
  topicLibraryTarget,
  type MenuItem,
  type TopicLibraryTarget,
  type TreeHandle,
  type TreeItem,
  type TreeKeyResult,
} from '@ui/vault';
import { NameDialog } from './dialogs';
import { useBump, useVaultQuery } from './hooks';
import { Action, Chip, Empty, IconAction, Loading, ViewHead } from './moreKit';
import { SyllabusWizard } from './SyllabusWizard';
import {
  addBlocked,
  addTopic,
  bankTopics,
  countTopics,
  flatTopics,
  heightOf,
  moveTopic,
  parseWeightInput,
  removeTopic,
  syllabusToMarkdown,
  updateTopic,
  type Edit,
  type MoveDirection,
} from './syllabusModel';
import { useTreeData } from './treeData';

/**
 * The syllabus editor: a user-made outline of an exam or course whose topics point at banks and
 * tags. Coverage (what the vault holds per topic) is shown on the review page's Analytics tab.
 *
 * Every edit is saved at once, one after another (so a held-down key cannot race itself), against
 * the version the editor last saw: a syllabus changed in another window is never overwritten.
 */

const FULL = `You can have at most ${MAX_SYLLABI} syllabi. Delete one first.`;

/** Blob URL + <a download>: the way an extension page writes a file without the downloads permission. */
function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const fileName = (name: string): string =>
  `${name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'syllabus'}.md`;

type Dialog = 'new' | 'rename' | null;

export function SyllabusView({
  initialId,
  onShowTopic,
}: {
  initialId: string | null;
  /** Open the highlight list for a topic. */
  onShowTopic(target: Exclude<TopicLibraryTarget, { kind: 'none' }>): void;
}) {
  const toast = useToast();
  const bump = useBump();
  const data = useTreeData();
  const list = useVaultQuery(() => listSyllabi(), []);
  const problems = useVaultQuery(() => checkSyllabi(), []);
  const [pickedId, setPickedId] = useState<string | null>(initialId);
  const [dialog, setDialog] = useState<Dialog>(null);

  const head = (action?: ReactNode) => (
    <ViewHead
      icon={ListTree}
      tone="success"
      title="Syllabus"
      titleId="syl-title"
      info="Your own outline of what an exam or course covers. Point each topic at the banks and tags that hold it; Stats on the review page then shows coverage per topic."
    >
      {action}
    </ViewHead>
  );
  // The title stays put while the list loads or fails, so the page does not jump.
  if (list.loading || list.error) {
    return (
      <section className="dash-panel mv-view syl" aria-labelledby="syl-title">
        {head()}
        {list.loading ? (
          <Loading>Loading your syllabi…</Loading>
        ) : (
          <InlineNotice
            tone="error"
            title="Could not read your syllabi"
            action={
              <ChunkyButton size="sm" onClick={list.refresh}>
                Try again
              </ChunkyButton>
            }
          >
            {list.error}
          </InlineNotice>
        )}
      </section>
    );
  }

  const syllabi = list.data ?? [];
  const current = syllabi.find((s) => s.id === pickedId) ?? syllabi[0] ?? null;
  const full = syllabi.length >= MAX_SYLLABI ? FULL : undefined;
  const starters = bankTopics(data.banks);
  const startersReason =
    data.counts === null
      ? 'Your banks are still loading.'
      : starters.length === 0
        ? 'You have no banks besides the Inbox yet.'
        : undefined;

  const created = async (name: string, nodes: SyllabusNodeInput[]) => {
    const made = await createSyllabus({ name, nodes });
    setPickedId(made.id);
    bump();
    setDialog(null);
    toast.push({ message: `Created the syllabus “${made.name}”.` });
  };

  const remove = async (s: Syllabus) => {
    try {
      await deleteSyllabus(s.id);
      bump();
      toast.push({
        message: `Deleted the syllabus “${s.name}”.`,
        action: {
          label: 'Undo',
          onClick: () => {
            void restoreSyllabus(s.id).then(
              () => {
                setPickedId(s.id);
                bump();
              },
              (err: unknown) =>
                toast.push({ tone: 'error', message: errorMessage(err, 'Could not restore it.') }),
            );
          },
        },
        focusAction: true,
      });
    } catch (err) {
      toast.push({ tone: 'error', message: errorMessage(err, 'Could not delete the syllabus.') });
    }
  };

  return (
    <section
      className="dash-panel mv-view syl"
      aria-labelledby="syl-title"
      data-testid="syllabus-view"
    >
      {/* While there is none, the empty state holds "New syllabus" instead. */}
      {head(
        current ? (
          <Action
            variant="primary"
            icon={Plus}
            onClick={() => setDialog('new')}
            disabledReason={full}
            data-testid="syllabus-new"
          >
            New syllabus
          </Action>
        ) : null,
      )}

      {current ? (
        <>
          <div className="syl-bar">
            <label className="syl-bar__pick">
              <span className="mv-label">Syllabus</span>
              <select
                className="sv-control"
                value={current.id}
                onChange={(e) => setPickedId(e.target.value)}
                data-testid="syllabus-select"
              >
                {syllabi.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <span className="syl-bar__actions">
              <IconAction
                icon={Pencil}
                label="Rename"
                onClick={() => setDialog('rename')}
                data-testid="syllabus-rename"
              />
              <a
                className="sv-chunky sv-chunky--sm"
                href={reviewPageUrl({ view: 'analytics' })}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="syllabus-coverage-link"
              >
                <ChartColumn className="sv-chunky__icon" aria-hidden="true" strokeWidth={2.5} />
                Coverage
                <span className="sv-vh"> (opens the review page)</span>
              </a>
              <IconAction
                icon={Trash}
                className="mv-ibtn--danger"
                label="Delete syllabus"
                tipSide="left"
                onClick={() => void remove(current)}
                data-testid="syllabus-delete"
              />
            </span>
          </div>
          <Editor
            key={current.id}
            syllabus={current}
            problems={(problems.data ?? []).filter((p) => p.syllabusId === current.id)}
            onShowTopic={onShowTopic}
          />
        </>
      ) : (
        <Empty
          title="No syllabus yet"
          text="Outline your exam, then map topics."
          action={{
            label: 'New syllabus',
            icon: Plus,
            onClick: () => setDialog('new'),
            testId: 'syllabus-new',
          }}
        />
      )}

      {dialog === 'new' ? (
        <SyllabusWizard
          starters={starters}
          startersReason={startersReason}
          onCreate={created}
          onCancel={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'rename' && current ? (
        <NameDialog
          title="Rename syllabus"
          label="Syllabus name"
          initial={current.name}
          confirmLabel="Rename"
          maxLength={MAX_SYLLABUS_NAME_CHARS}
          onSubmit={async (name) => {
            await updateSyllabus(current.id, { name });
            bump();
            setDialog(null);
          }}
          onCancel={() => setDialog(null)}
        />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------------------------

function Editor({
  syllabus,
  problems,
  onShowTopic,
}: {
  syllabus: Syllabus;
  problems: SyllabusProblem[];
  onShowTopic(target: Exclude<TopicLibraryTarget, { kind: 'none' }>): void;
}) {
  const toast = useToast();
  const bump = useBump();
  const data = useTreeData();
  const [nodes, setNodes] = useState<SyllabusNode[]>(syllabus.nodes);
  const [topicId, setTopicId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const treeRef = useRef<TreeHandle>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [focusRequest, setFocusRequest] = useState<{ id: string; n: number } | null>(null);
  const [titleFocus, setTitleFocus] = useState(0);
  const [menu, setMenu] = useState<{ id: string; at: { x: number; y: number } } | null>(null);

  // What was last read from or written to the vault, and the writes still in flight.
  const sync = useRef({
    version: syllabus.updatedAt,
    nodes: syllabus.nodes,
    pending: 0,
    chain: Promise.resolve(),
  });

  // A newer stored version (another window, or our own write coming back) is adopted when nothing
  // of ours is waiting to be saved.
  useEffect(() => {
    const s = sync.current;
    if (s.pending > 0 || syllabus.updatedAt <= s.version) return;
    s.version = syllabus.updatedAt;
    s.nodes = syllabus.nodes;
    setNodes(syllabus.nodes);
  }, [syllabus]);

  const commit = useCallback(
    (next: SyllabusNode[]) => {
      const s = sync.current;
      s.nodes = next;
      s.pending += 1;
      setNodes(next);
      s.chain = s.chain.then(async () => {
        try {
          const out = await updateSyllabus(
            syllabus.id,
            { nodes: s.nodes },
            { expectedVersion: s.version },
          );
          s.version = out.row.updatedAt;
          if (out.status === 'stale') {
            s.nodes = out.row.nodes;
            setNodes(out.row.nodes);
            toast.push({
              message:
                'This syllabus was changed in another window. The latest version is shown; repeat your change if it is missing.',
            });
          }
        } catch (err) {
          toast.push({ tone: 'error', message: errorMessage(err, 'The change was not saved.') });
          // Show what is really stored instead of an edit that did not happen.
          try {
            const fresh = await getSyllabus(syllabus.id);
            if (fresh) {
              s.version = fresh.updatedAt;
              s.nodes = fresh.nodes;
              setNodes(fresh.nodes);
            }
          } catch {
            /* the next refresh of the list will correct it */
          }
        } finally {
          s.pending -= 1;
          bump();
        }
      });
    },
    [syllabus.id, toast, bump],
  );

  // Focus follows a keyboard move: reordering moves the node in the DOM, which can drop focus.
  useEffect(() => {
    if (focusRequest) treeRef.current?.focus(focusRequest.id);
  }, [focusRequest]);
  useEffect(() => {
    if (titleFocus > 0) {
      titleRef.current?.focus();
      titleRef.current?.select();
    }
  }, [titleFocus]);

  const byId = useMemo(() => new Map(flatTopics(nodes).map((t) => [t.node.id, t.node])), [nodes]);
  const topic = topicId === null ? null : (byId.get(topicId) ?? null);
  const mappings = useMemo(() => subtreeMappings(nodes), [nodes]);
  const banks = useMemo(() => new Map(data.banks.map((b) => [b.id, b.name])), [data.banks]);
  const tags = useMemo(() => new Map(data.tags.map((t) => [t.tag.id, t.tag.name])), [data.tags]);

  const items = useMemo<TreeItem[]>(() => {
    const build = (list: readonly SyllabusNode[]): TreeItem[] =>
      list.map((n) => ({ id: n.id, label: n.title, children: build(n.children) }));
    return build(nodes);
  }, [nodes]);
  const expanded = useMemo(
    () =>
      new Set(
        flatTopics(nodes)
          .filter((t) => t.node.children.length > 0 && !collapsed.has(t.node.id))
          .map((t) => t.node.id),
      ),
    [nodes, collapsed],
  );

  const count = countTopics(nodes);
  const depth = nodes.reduce((h, n) => Math.max(h, heightOf(n)), 0);
  const mapped = flatTopics(nodes).filter(
    (t) => t.node.bankIds.length + t.node.tagIds.length > 0,
  ).length;

  const apply = (edit: Edit, focus = false): boolean => {
    if (!edit.ok) {
      toast.push({ message: edit.reason });
      return false;
    }
    commit(edit.nodes);
    if (edit.select !== null) {
      setTopicId(edit.select);
      if (focus) setFocusRequest((r) => ({ id: edit.select as string, n: (r?.n ?? 0) + 1 }));
    }
    return true;
  };

  const move = (id: string, direction: MoveDirection, viaKeyboard: boolean) => {
    if (apply(moveTopic(nodes, id, direction), viaKeyboard)) {
      // The sibling above becomes the parent of an indented topic: show it.
      if (direction === 'indent') setCollapsed((c) => new Set([...c].filter((x) => x !== id)));
    }
  };

  const deleteTopic = (id: string) => {
    const before = nodes;
    const gone = byId.get(id);
    const removed = removeTopic(nodes, id);
    if (!apply(removed, true) || !gone) return;
    const subtopics = countTopics(gone.children);
    toast.push({
      message: `Deleted “${gone.title}”${subtopics > 0 ? ` and ${plural(subtopics, 'subtopic')}` : ''}.`,
      action: {
        label: 'Undo',
        onClick: () => {
          commit(before);
          setTopicId(id);
        },
      },
      focusAction: true,
    });
  };

  const onCommand = (command: Extract<TreeKeyResult, { type: 'rename' | 'delete' | 'move' }>) => {
    if (command.type === 'rename') {
      setTopicId(command.id);
      setTitleFocus((n) => n + 1);
    } else if (command.type === 'delete') deleteTopic(command.id);
    else move(command.id, command.direction, true);
  };

  const probe = useMemo(() => {
    const reasons: Record<MoveDirection, string | undefined> = {
      up: undefined,
      down: undefined,
      indent: undefined,
      outdent: undefined,
    };
    for (const d of ['up', 'down', 'indent', 'outdent'] as const) {
      if (topicId === null || !byId.has(topicId)) reasons[d] = 'Select a topic first.';
      else {
        const r = moveTopic(nodes, topicId, d);
        reasons[d] = r.ok ? undefined : r.reason;
      }
    }
    return reasons;
  }, [nodes, topicId, byId]);

  const addReason = addBlocked(nodes, topic?.id ?? null, 'after');
  const subReason = topic === null ? 'Select a topic first.' : addBlocked(nodes, topic.id, 'child');

  const target = topic ? mappings.get(topic.id) : undefined;
  const library = target ? topicLibraryTarget(target, banks, tags) : null;
  const myProblems = problems.filter((p) => p.nodeId === topicId);

  return (
    <div className="syl-editor">
      <div className="mv-card syl-strip">
        <ProgressRing
          value={mapped}
          max={count}
          label="Mapped topics"
          unit="topics"
          tone="success"
          size={76}
          stroke={10}
          description="Topics that point at a bank or a tag."
        >
          <span className="syl-strip__n">{count === 0 ? '–' : `${mapped}/${count}`}</span>
        </ProgressRing>
        <span className="syl-strip__body">
          <span className="syl-strip__title">
            Mapped topics
            <InfoTip label="About mapped topics">
              A mapped topic points at a bank or a tag, so its material can be counted. Select a
              topic to map it. A syllabus holds up to {MAX_SYLLABUS_NODES} topics in{' '}
              {MAX_SYLLABUS_DEPTH} levels.
            </InfoTip>
          </span>
          {/* The chips draw the line below; the line is what a screen reader hears. */}
          <span className="mv-row" aria-hidden="true">
            <Chip icon={ListTree} tone="success">
              {plural(count, 'topic')}
            </Chip>
            <Chip icon={Layers}>{plural(depth, 'level')}</Chip>
            {problems.length > 0 ? (
              <Chip icon={TriangleAlert} tone="warning">
                {plural(problems.length, 'broken link')}
              </Chip>
            ) : null}
          </span>
          <span className="sv-vh" data-testid="syllabus-size">
            {count} of {MAX_SYLLABUS_NODES} topics · {depth} of {MAX_SYLLABUS_DEPTH} levels
            {problems.length > 0
              ? ` · ${plural(problems.length, 'mapping')} point at something deleted`
              : ''}
          </span>
        </span>
        <ChunkyButton
          size="sm"
          icon={Download}
          className="syl-strip__export"
          onClick={() =>
            downloadText(fileName(syllabus.name), syllabusToMarkdown(syllabus.name, nodes))
          }
          data-testid="syllabus-export"
        >
          Export
        </ChunkyButton>
      </div>

      <div className="syl-grid">
        <section className="mv-card syl-topics" aria-label="Topics">
          <div className="syl-tools" role="group" aria-label="Topic actions">
            <Action
              size="sm"
              variant="primary"
              icon={Plus}
              onClick={() => {
                if (apply(addTopic(nodes, topic?.id ?? null, 'after'))) {
                  setTitleFocus((n) => n + 1);
                  toast.announce('Topic added. Type its title.');
                }
              }}
              disabledReason={addReason}
              data-testid="topic-add"
            >
              Topic
            </Action>
            <Action
              size="sm"
              icon={Plus}
              onClick={() => {
                if (topic && apply(addTopic(nodes, topic.id, 'child'))) {
                  setCollapsed((c) => new Set([...c].filter((x) => x !== topic.id)));
                  setTitleFocus((n) => n + 1);
                  toast.announce('Subtopic added. Type its title.');
                }
              }}
              disabledReason={subReason}
              data-testid="topic-add-child"
            >
              Subtopic
            </Action>
            <span className="syl-tools__icons">
              {(
                [
                  ['up', 'Move up', ArrowUp],
                  ['down', 'Move down', ArrowDown],
                  ['indent', 'Indent', IndentIncrease],
                  ['outdent', 'Outdent', IndentDecrease],
                ] as const
              ).map(([direction, label, icon]) => (
                <IconAction
                  key={direction}
                  icon={icon}
                  label={label}
                  disabledReason={probe[direction]}
                  onClick={() => topicId && move(topicId, direction, false)}
                  data-testid={`topic-${direction}`}
                />
              ))}
              <IconAction
                icon={Trash}
                className="mv-ibtn--danger"
                label="Delete topic"
                tipSide="left"
                disabledReason={topic === null ? 'Select a topic first.' : undefined}
                onClick={() => topic && deleteTopic(topic.id)}
                data-testid="topic-delete"
              />
              <InfoTip label="Keyboard keys for topics" align="end">
                Arrow keys move through the topics. Alt+Up and Alt+Down reorder, Alt+Right indents,
                Alt+Left outdents, F2 edits the title, Delete removes.
              </InfoTip>
            </span>
          </div>
          {nodes.length === 0 ? (
            <BuddyEmptyState
              pose="sleep"
              mascotSize={88}
              heading="h4"
              title="This syllabus has no topics yet"
              text="Add the first one with Topic."
            />
          ) : (
            <Tree
              ref={treeRef}
              label={`Topics of ${syllabus.name}`}
              items={items}
              expanded={expanded}
              onExpandedChange={(next) =>
                setCollapsed(
                  new Set(
                    flatTopics(nodes)
                      .filter((t) => t.node.children.length > 0 && !next.has(t.node.id))
                      .map((t) => t.node.id),
                  ),
                )
              }
              selectedId={topicId}
              onActivate={setTopicId}
              onCommand={onCommand}
              onContextMenu={(id, at) => {
                setTopicId(id);
                setMenu({ id, at });
              }}
              className="syl-tree"
              renderItem={(v) => {
                const n = byId.get(v.item.id);
                if (!n) return null;
                const links = n.bankIds.length + n.tagIds.length;
                return (
                  <span className="syl-item">
                    <span className="syl-item__name" dir="auto">
                      {n.title}
                    </span>{' '}
                    <span className="syl-item__chips">
                      {n.weight !== undefined ? (
                        <Chip icon={Scale} tone="sun" prefix="Weight">
                          {String(n.weight)}
                        </Chip>
                      ) : null}
                      {links === 0 ? (
                        <Chip tone="neutral">Not mapped</Chip>
                      ) : (
                        <>
                          {n.bankIds.length > 0 ? (
                            <Chip icon={Library} tone="primary">
                              {plural(n.bankIds.length, 'bank')}
                            </Chip>
                          ) : null}
                          {n.tagIds.length > 0 ? (
                            <Chip icon={Tag} tone="success">
                              {plural(n.tagIds.length, 'tag')}
                            </Chip>
                          ) : null}
                        </>
                      )}
                    </span>
                  </span>
                );
              }}
            />
          )}
        </section>

        <section
          className="mv-card syl-details"
          aria-label="Topic details"
          data-testid="topic-details"
        >
          {topic === null ? (
            <div className="syl-pick">
              <VaultBuddy pose="think" size={72} />
              <p className="mv-line">
                <MousePointerClick aria-hidden="true" className="syl-pick__icon" /> Select a topic
                to edit and map it.
              </p>
            </div>
          ) : (
            <TopicForm
              key={topic.id}
              topic={topic}
              banks={data.banks.map((b) => ({ id: b.id, name: b.name }))}
              tags={data.tags.map((t) => ({ id: t.tag.id, name: t.tag.name }))}
              loaded={data.counts !== null}
              titleRef={titleRef}
              problems={myProblems}
              onChange={(patch) => apply(updateTopic(nodes, topic.id, patch))}
              library={library}
              onShow={onShowTopic}
            />
          )}
        </section>
      </div>

      {menu && byId.has(menu.id) ? (
        <TopicMenu
          id={menu.id}
          title={byId.get(menu.id)?.title ?? 'topic'}
          nodes={nodes}
          at={menu.at}
          onClose={() => setMenu(null)}
          onAddChild={(id) => {
            if (apply(addTopic(nodes, id, 'child'))) {
              setCollapsed((c) => new Set([...c].filter((x) => x !== id)));
              setTitleFocus((n) => n + 1);
            }
          }}
          onMove={(id, direction) => move(id, direction, false)}
          onDelete={deleteTopic}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// One topic
// ---------------------------------------------------------------------------------------------

function TopicForm({
  topic,
  banks,
  tags,
  loaded,
  titleRef,
  problems,
  onChange,
  library,
  onShow,
}: {
  topic: SyllabusNode;
  banks: { id: string; name: string }[];
  tags: { id: string; name: string }[];
  loaded: boolean;
  titleRef: RefObject<HTMLInputElement | null>;
  problems: SyllabusProblem[];
  onChange(patch: {
    title?: string;
    weight?: number | null;
    bankIds?: string[];
    tagIds?: string[];
  }): boolean;
  library: TopicLibraryTarget | null;
  onShow(target: Exclude<TopicLibraryTarget, { kind: 'none' }>): void;
}) {
  const titleId = useId();
  const weightId = useId();
  const weightHelp = useId();
  const [title, setTitle] = useState(topic.title);
  const [weight, setWeight] = useState(topic.weight === undefined ? '' : String(topic.weight));
  const [titleError, setTitleError] = useState<string | null>(null);
  const weightCheck = parseWeightInput(weight);

  // The stored value moved underneath (an undo, another window): follow it.
  const [seenTitle, setSeenTitle] = useState(topic.title);
  if (topic.title !== seenTitle) {
    setSeenTitle(topic.title);
    setTitle(topic.title);
  }
  const storedWeight = topic.weight === undefined ? '' : String(topic.weight);
  const [seenWeight, setSeenWeight] = useState(storedWeight);
  if (storedWeight !== seenWeight) {
    setSeenWeight(storedWeight);
    setWeight(storedWeight);
  }

  const commitTitle = () => {
    const t = title.trim();
    if (t === topic.title) {
      setTitle(topic.title);
      setTitleError(null);
      return;
    }
    if (t === '') {
      setTitleError('A topic needs a title.');
      return;
    }
    setTitleError(null);
    onChange({ title: t });
  };
  const commitWeight = () => {
    if (!weightCheck.ok || weightCheck.weight === (topic.weight ?? null)) return;
    onChange({ weight: weightCheck.weight });
  };

  const hasChildren = topic.children.length > 0;
  const mapped = topic.bankIds.length + topic.tagIds.length > 0;

  return (
    <div className="syl-form" aria-label={`Topic: ${topic.title}`} role="group">
      <div className="syl-form__pair">
        <div className="mv-field">
          <label htmlFor={titleId}>Title</label>
          <input
            ref={titleRef}
            id={titleId}
            className="sv-control"
            value={title}
            maxLength={MAX_SYLLABUS_TITLE_CHARS}
            dir="auto"
            autoComplete="off"
            aria-invalid={titleError !== null || undefined}
            aria-describedby={titleError ? `${titleId}-err` : undefined}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitTitle();
              } else if (e.key === 'Escape') {
                setTitle(topic.title);
                setTitleError(null);
              }
            }}
            data-testid="topic-title"
          />
          {titleError ? (
            <p id={`${titleId}-err`} className="mv-error" role="alert">
              <TriangleAlert aria-hidden="true" />
              {titleError}
            </p>
          ) : null}
        </div>

        <div className="mv-field syl-form__weight">
          <span className="syl-wiz-label">
            <label htmlFor={weightId}>Weight</label>
            <InfoTip label="About weight" align="end">
              Relative importance among its siblings. Empty means an equal share (at most{' '}
              {MAX_SYLLABUS_WEIGHT}).
            </InfoTip>
          </span>
          <input
            id={weightId}
            className="sv-control"
            inputMode="decimal"
            value={weight}
            placeholder="Equal"
            autoComplete="off"
            aria-invalid={!weightCheck.ok || undefined}
            aria-describedby={weightCheck.ok ? undefined : weightHelp}
            onChange={(e) => setWeight(e.target.value)}
            onBlur={commitWeight}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitWeight();
              }
            }}
            data-testid="topic-weight"
          />
          {weightCheck.ok ? null : (
            <p id={weightHelp} className="mv-error" role="alert">
              <TriangleAlert aria-hidden="true" />
              {weightCheck.message}
            </p>
          )}
        </div>
      </div>

      <MappingPicker
        legend="Banks"
        noun="bank"
        icon={Library}
        options={banks}
        selected={topic.bankIds}
        max={MAX_SYLLABUS_LINKS}
        loaded={loaded}
        onChange={(bankIds) => onChange({ bankIds })}
        testId="topic-banks"
      />
      <MappingPicker
        legend="Tags"
        noun="tag"
        icon={Tag}
        options={tags}
        selected={topic.tagIds}
        max={MAX_SYLLABUS_LINKS}
        loaded={loaded}
        onChange={(tagIds) => onChange({ tagIds })}
        testId="topic-tags"
      />

      {hasChildren && mapped ? (
        <InlineNotice tone="info">
          This topic has subtopics: its coverage is judged from them.
        </InlineNotice>
      ) : null}
      {problems.length > 0 ? (
        <InlineNotice tone="warning" title="Some of what this topic points at is gone">
          {plural(problems.length, 'bank or tag')} deleted or in the trash. Restore it or untick it.
        </InlineNotice>
      ) : null}

      <div className="mv-row">
        <Action
          variant="primary"
          icon={Search}
          disabledReason={
            library === null || library.kind === 'none'
              ? (library?.reason ?? 'Select a topic first.')
              : undefined
          }
          onClick={() => library && library.kind !== 'none' && onShow(library)}
          data-testid="topic-show"
        >
          Show highlights
        </Action>
        {library?.kind === 'search' && library.used < library.total ? (
          <span className="mv-line">
            The search holds {library.used} of its {library.total} banks and tags.
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------------------------

const MOVES = [
  ['up', 'Move up', 'Alt+Up'],
  ['down', 'Move down', 'Alt+Down'],
  ['indent', 'Indent', 'Alt+Right'],
  ['outdent', 'Outdent', 'Alt+Left'],
] as const;

/** The actions of one topic (Menu key, Shift+F10, right click); each says why it cannot run. */
function TopicMenu({
  id,
  title,
  nodes,
  at,
  onClose,
  onAddChild,
  onMove,
  onDelete,
}: {
  id: string;
  title: string;
  nodes: readonly SyllabusNode[];
  at: { x: number; y: number };
  onClose(): void;
  onAddChild(id: string): void;
  onMove(id: string, direction: MoveDirection): void;
  onDelete(id: string): void;
}) {
  const why = (edit: Edit) => (edit.ok ? undefined : edit.reason);
  const items: MenuItem[] = [
    {
      id: 'child',
      label: 'New subtopic',
      disabledReason: addBlocked(nodes, id, 'child'),
      onSelect: () => onAddChild(id),
    },
    ...MOVES.map(([direction, label, hint]) => ({
      id: direction,
      label,
      hint,
      disabledReason: why(moveTopic(nodes, id, direction)),
      onSelect: () => onMove(id, direction),
    })),
    {
      id: 'delete',
      label: 'Delete topic',
      hint: 'Delete',
      danger: true,
      separatorBefore: true,
      onSelect: () => onDelete(id),
    },
  ];
  return <PopupMenu label={`Actions for ${title}`} items={items} at={at} onClose={onClose} />;
}

// ---------------------------------------------------------------------------------------------
// Bank and tag picker
// ---------------------------------------------------------------------------------------------

const SHOWN = 100;

function MappingPicker({
  legend,
  noun,
  icon: Icon,
  options,
  selected,
  max,
  loaded,
  onChange,
  testId,
}: {
  legend: string;
  noun: 'bank' | 'tag';
  icon: typeof Library;
  options: { id: string; name: string }[];
  selected: readonly string[];
  max: number;
  loaded: boolean;
  onChange(next: string[]): void;
  testId: string;
}) {
  const filterId = useId();
  const [filter, setFilter] = useState('');
  const chosen = new Set(selected);
  const known = new Set(options.map((o) => o.id));
  const missing = selected.filter((id) => !known.has(id));
  const needle = filter.trim().toLowerCase();
  // What the topic pointed at when it was opened comes first, so it is in sight without
  // scrolling; a pill ticked now stays where it is (nothing moves under the pointer or the focus).
  const [opened] = useState(() => new Set(selected));
  const shown = options
    .filter((o) => needle === '' || o.name.toLowerCase().includes(needle))
    .sort((a, b) => Number(opened.has(b.id)) - Number(opened.has(a.id)));
  const atMax = selected.length >= max;
  const toggle = (id: string) =>
    onChange(chosen.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const pill = (id: string, on: boolean, text: string, warn = false) => (
    <label
      key={id}
      className={`mv-pill${warn ? ' syl-pill--gone' : ''}`}
      data-on={on ? '' : undefined}
    >
      <input
        type="checkbox"
        className="sv-vh"
        checked={on}
        disabled={atMax && !on}
        onChange={() => toggle(id)}
      />
      <span className="mv-pill__tick" aria-hidden="true" />
      <span dir="auto">{text}</span>
    </label>
  );

  return (
    <fieldset className="mv-pills syl-picker" data-testid={testId}>
      <legend className="mv-label syl-picker__legend">
        <Icon aria-hidden="true" />
        {legend}{' '}
        <span className="mv-meta">
          ({selected.length} of {max})
        </span>
      </legend>
      {options.length > 8 ? (
        <div className="mv-field syl-picker__find">
          <label className="sv-vh" htmlFor={filterId}>
            Find a {noun}
          </label>
          <input
            id={filterId}
            type="search"
            className="sv-control"
            value={filter}
            placeholder={`Find a ${noun}`}
            autoComplete="off"
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      ) : null}
      <div className="mv-pills__list">
        {missing.map((id) =>
          pill(id, true, `A ${noun} that is deleted or in the trash (untick to remove)`, true),
        )}
        {shown.slice(0, SHOWN).map((o) => pill(o.id, chosen.has(o.id), o.name))}
      </div>
      {loaded && options.length === 0 ? <p className="mv-line">You have no {noun}s yet.</p> : null}
      {shown.length > SHOWN ? (
        <p className="mv-line">
          Showing the first {SHOWN} of {shown.length}. Type to narrow the list.
        </p>
      ) : null}
      {atMax ? (
        <p className="mv-line">
          At most {max} {noun}s. Untick one first.
        </p>
      ) : null}
    </fieldset>
  );
}

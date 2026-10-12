import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
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
import { Button, EmptyState, InlineNotice, errorMessage, plural, useToast } from '@ui';
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
import { FormDialog, NameDialog } from './dialogs';
import { useBump, useVaultQuery } from './hooks';
import {
  OUTLINE_MAX_CHARS,
  addBlocked,
  addTopic,
  bankTopics,
  countTopics,
  flatTopics,
  heightOf,
  moveTopic,
  outlineToInputs,
  parseOutline,
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

type Dialog = 'new' | 'rename' | 'import' | null;

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
  const selectId = useId();

  if (list.loading) {
    return (
      <p className="sv-muted dash-loading" role="status">
        Loading your syllabi…
      </p>
    );
  }
  if (list.error) {
    return (
      <InlineNotice
        tone="error"
        title="Could not read your syllabi"
        action={<Button onClick={list.refresh}>Try again</Button>}
      >
        {list.error}
      </InlineNotice>
    );
  }

  const syllabi = list.data ?? [];
  const current = syllabi.find((s) => s.id === pickedId) ?? syllabi[0] ?? null;
  const full = syllabi.length >= MAX_SYLLABI ? FULL : undefined;
  const starters = bankTopics(data.banks);

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
    <section className="dash-panel syl" aria-labelledby="syl-title" data-testid="syllabus-view">
      <h2 id="syl-title">Syllabus</h2>
      <p className="sv-small sv-muted">
        A syllabus is your own outline of what an exam or course covers. Point each topic at the
        banks and tags that hold its material; the Analytics tab of the review page then shows what
        you have, and how well you know it, per topic. Nothing is guessed from text.
      </p>

      <div className="sv-row syl-bar">
        {syllabi.length > 0 ? (
          <div className="sv-field">
            <label className="sv-label" htmlFor={selectId}>
              Syllabus
            </label>
            <select
              id={selectId}
              className="sv-control"
              value={current?.id ?? ''}
              onChange={(e) => setPickedId(e.target.value)}
              data-testid="syllabus-select"
            >
              {syllabi.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <Button onClick={() => setDialog('new')} disabledReason={full} data-testid="syllabus-new">
          New syllabus…
        </Button>
        <Button
          onClick={() => setDialog('import')}
          disabledReason={full}
          data-testid="syllabus-import"
        >
          Import an outline…
        </Button>
        <Button
          disabledReason={
            full ??
            (data.counts === null
              ? 'Your banks are still loading.'
              : starters.length === 0
                ? 'You have no banks besides the Inbox yet.'
                : undefined)
          }
          onClick={() => {
            void created('From my banks', starters).catch((err: unknown) =>
              toast.push({
                tone: 'error',
                message: errorMessage(err, 'Could not create the syllabus.'),
              }),
            );
          }}
          data-testid="syllabus-from-banks"
        >
          Start from my banks
        </Button>
      </div>

      {current ? (
        <>
          <div className="sv-row">
            <Button onClick={() => setDialog('rename')} data-testid="syllabus-rename">
              Rename…
            </Button>
            <a
              className="sv-btn sv-btn--secondary"
              href={reviewPageUrl({ view: 'analytics' })}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="syllabus-coverage-link"
            >
              See coverage (review page)
            </a>
            <Button
              variant="danger"
              onClick={() => void remove(current)}
              data-testid="syllabus-delete"
            >
              Delete syllabus
            </Button>
          </div>
          <Editor
            key={current.id}
            syllabus={current}
            problems={(problems.data ?? []).filter((p) => p.syllabusId === current.id)}
            onShowTopic={onShowTopic}
          />
        </>
      ) : (
        <EmptyState title="You have no syllabus yet">
          Create an empty one, paste an outline, or start from your banks (one topic per bank). Then
          point topics at banks and tags to see coverage.
        </EmptyState>
      )}

      {dialog === 'new' ? (
        <NameDialog
          title="New syllabus"
          label="Syllabus name"
          confirmLabel="Create syllabus"
          maxLength={MAX_SYLLABUS_NAME_CHARS}
          onSubmit={(name) => created(name, [])}
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
      {dialog === 'import' ? (
        <ImportDialog onCreate={created} onCancel={() => setDialog(null)} />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------

const PREVIEW_LINES = 60;

function ImportDialog({
  onCreate,
  onCancel,
}: {
  onCreate(name: string, nodes: SyllabusNodeInput[]): Promise<void>;
  onCancel(): void;
}) {
  const textId = useId();
  const nameId = useId();
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const parsed = useMemo(() => parseOutline(text), [text]);
  const finalName = (name.trim() || parsed.name || 'Imported outline').slice(
    0,
    MAX_SYLLABUS_NAME_CHARS,
  );
  const preview = useMemo(() => {
    const lines: Array<{ depth: number; title: string; weight?: number }> = [];
    const walk = (topics: typeof parsed.topics, depth: number) => {
      for (const t of topics) {
        if (lines.length > PREVIEW_LINES) return;
        lines.push({
          depth,
          title: t.title,
          ...(t.weight === undefined ? {} : { weight: t.weight }),
        });
        walk(t.children, depth + 1);
      }
    };
    walk(parsed.topics, 1);
    return lines;
  }, [parsed]);

  const reason =
    text.trim() === ''
      ? 'Paste an outline first.'
      : parsed.errors.length > 0
        ? 'Fix the problems listed first.'
        : parsed.count === 0
          ? 'No topics were found in the text.'
          : undefined;

  return (
    <FormDialog
      title="Import an outline"
      confirmLabel="Create syllabus"
      disabledReason={reason}
      onSubmit={() => onCreate(finalName, outlineToInputs(parsed.topics))}
      onCancel={onCancel}
      wide
      testId="syllabus-import-dialog"
    >
      <p className="sv-small sv-muted">
        Paste a nested list (bullets, numbers or plain indented lines) or Markdown headings. A first{' '}
        <code># Title</code> line names the syllabus; a trailing <code>(weight 2)</code> sets a
        weight. Topics are created without banks or tags: map them afterwards. Nothing is saved
        until you press the button.
      </p>
      <div className="sv-field">
        <label className="sv-label" htmlFor={textId}>
          Outline
        </label>
        <textarea
          id={textId}
          className="sv-control syl-outline"
          rows={9}
          value={text}
          spellCheck={false}
          dir="auto"
          data-autofocus=""
          onChange={(e) => setText(e.target.value)}
          data-testid="syllabus-import-text"
        />
      </div>
      <div className="sv-field">
        <label className="sv-label" htmlFor={nameId}>
          Syllabus name
        </label>
        <input
          id={nameId}
          className="sv-control"
          value={name}
          placeholder={parsed.name ?? 'Imported outline'}
          maxLength={MAX_SYLLABUS_NAME_CHARS}
          dir="auto"
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
          data-testid="syllabus-import-name"
        />
      </div>

      <div aria-live="polite" data-testid="syllabus-import-summary">
        {text.trim() === '' ? (
          <p className="sv-muted">The preview appears here as you paste.</p>
        ) : parsed.errors.length > 0 ? (
          <p>This outline cannot be imported yet:</p>
        ) : (
          <p>
            <strong>
              {plural(parsed.count, 'topic')} in {plural(parsed.depth, 'level')}
            </strong>{' '}
            will be created as “{finalName}”. This is a preview; nothing has been saved.
          </p>
        )}
      </div>
      {parsed.errors.length > 0 ? (
        <ul className="sv-stack sv-stack--tight syl-issues" data-testid="syllabus-import-errors">
          {parsed.errors.slice(0, 8).map((e, i) => (
            <li key={`${e.line}-${i}`}>
              {e.line > 0 ? `Line ${e.line}: ` : ''}
              {e.message}
            </li>
          ))}
          {parsed.errors.length > 8 ? <li>…and {parsed.errors.length - 8} more.</li> : null}
        </ul>
      ) : null}
      {parsed.notes.length > 0 && parsed.errors.length === 0 ? (
        <details className="rv-details">
          <summary>{plural(parsed.notes.length, 'line')} read with an assumption</summary>
          <ul className="rv-details__body sv-stack sv-stack--tight">
            {parsed.notes.slice(0, 12).map((n, i) => (
              <li key={`${n.line}-${i}`}>
                Line {n.line}: {n.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {preview.length > 0 && parsed.errors.length === 0 ? (
        <ol
          className="syl-preview"
          aria-label="Preview of the topics"
          data-testid="syllabus-import-preview"
        >
          {preview.slice(0, PREVIEW_LINES).map((l, i) => (
            <li key={i} style={{ paddingInlineStart: `${(l.depth - 1) * 1.25}rem` }} dir="auto">
              {l.title}
              {l.weight !== undefined ? (
                <span className="sv-small sv-muted"> (weight {l.weight})</span>
              ) : null}
            </li>
          ))}
          {preview.length > PREVIEW_LINES ? <li className="sv-muted">…and more.</li> : null}
        </ol>
      ) : null}
      <p className="sv-small sv-muted">
        At most {MAX_SYLLABUS_NODES} topics, {MAX_SYLLABUS_DEPTH} levels, titles of{' '}
        {MAX_SYLLABUS_TITLE_CHARS} characters and {OUTLINE_MAX_CHARS.toLocaleString()} characters of
        text.
      </p>
    </FormDialog>
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
    <div className="syl-editor sv-stack">
      <p className="sv-small sv-muted" data-testid="syllabus-size">
        {count} of {MAX_SYLLABUS_NODES} topics · {depth} of {MAX_SYLLABUS_DEPTH} levels
        {problems.length > 0
          ? ` · ${plural(problems.length, 'mapping')} point at something deleted`
          : ''}
      </p>

      <div className="sv-row" role="group" aria-label="Topic actions">
        <Button
          onClick={() =>
            downloadText(fileName(syllabus.name), syllabusToMarkdown(syllabus.name, nodes))
          }
          data-testid="syllabus-export"
        >
          Export as Markdown
        </Button>
        <Button
          onClick={() => {
            if (apply(addTopic(nodes, topic?.id ?? null, 'after'))) {
              setTitleFocus((n) => n + 1);
              toast.announce('Topic added. Type its title.');
            }
          }}
          disabledReason={addReason}
          data-testid="topic-add"
        >
          New topic{topic ? ' after this one' : ''}
        </Button>
        <Button
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
          New subtopic
        </Button>
        {(
          [
            ['up', 'Move up'],
            ['down', 'Move down'],
            ['indent', 'Indent'],
            ['outdent', 'Outdent'],
          ] as const
        ).map(([direction, label]) => (
          <Button
            key={direction}
            disabledReason={probe[direction]}
            onClick={() => topicId && move(topicId, direction, false)}
            data-testid={`topic-${direction}`}
          >
            {label}
          </Button>
        ))}
        <Button
          variant="danger"
          disabledReason={topic === null ? 'Select a topic first.' : undefined}
          onClick={() => topic && deleteTopic(topic.id)}
          data-testid="topic-delete"
        >
          Delete topic
        </Button>
      </div>

      <div className="dash-two-col syl-grid">
        <div className="sv-stack sv-stack--tight">
          {nodes.length === 0 ? (
            <EmptyState title="This syllabus has no topics yet">
              Add the first topic with “New topic”.
            </EmptyState>
          ) : (
            <>
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
                  const mapped = n.bankIds.length + n.tagIds.length;
                  return (
                    <>
                      <span className="syl-name" dir="auto">
                        {n.title}
                      </span>{' '}
                      <span className="sv-small sv-muted">
                        {n.weight !== undefined ? `weight ${n.weight} · ` : ''}
                        {mapped === 0
                          ? 'not mapped'
                          : `${plural(n.bankIds.length, 'bank')}, ${plural(n.tagIds.length, 'tag')}`}
                      </span>
                    </>
                  );
                }}
              />
              <p className="sv-small sv-muted">
                Arrow keys move through the topics. Alt+Up and Alt+Down reorder, Alt+Right indents,
                Alt+Left outdents, F2 edits the title, Delete removes. The buttons above do the
                same.
              </p>
            </>
          )}
        </div>

        <div className="sv-stack" data-testid="topic-details">
          {topic === null ? (
            <p className="sv-muted">
              Select a topic to change its title and weight and to point it at banks and tags.
            </p>
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
        </div>
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
    <section className="sv-stack" aria-label={`Topic: ${topic.title}`}>
      <div className="sv-field">
        <label className="sv-label" htmlFor={titleId}>
          Title
        </label>
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
          <p id={`${titleId}-err`} className="syl-error sv-small" role="alert">
            {titleError}
          </p>
        ) : null}
      </div>

      <div className="sv-field">
        <label className="sv-label" htmlFor={weightId}>
          Weight
        </label>
        <input
          id={weightId}
          className="sv-control syl-weight"
          inputMode="decimal"
          value={weight}
          autoComplete="off"
          aria-invalid={!weightCheck.ok || undefined}
          aria-describedby={weightHelp}
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
        <p
          id={weightHelp}
          className={`sv-small ${weightCheck.ok ? 'sv-muted' : 'syl-error'}`}
          role={weightCheck.ok ? undefined : 'alert'}
        >
          {weightCheck.ok
            ? `Relative importance among its siblings. Empty means an equal share (at most ${MAX_SYLLABUS_WEIGHT}).`
            : weightCheck.message}
        </p>
      </div>

      <MappingPicker
        legend="Banks"
        noun="bank"
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
        options={tags}
        selected={topic.tagIds}
        max={MAX_SYLLABUS_LINKS}
        loaded={loaded}
        onChange={(tagIds) => onChange({ tagIds })}
        testId="topic-tags"
      />

      {hasChildren && mapped ? (
        <InlineNotice tone="info">
          This topic has subtopics. What it points at counts towards its totals, but its coverage is
          judged from its subtopics.
        </InlineNotice>
      ) : null}
      {problems.length > 0 ? (
        <InlineNotice tone="warning" title="Some of what this topic points at is gone">
          {plural(problems.length, 'bank or tag')} deleted or in the trash. It covers nothing until
          you restore it or untick it above.
        </InlineNotice>
      ) : null}

      <div className="sv-row">
        <Button
          variant="primary"
          disabledReason={
            library === null || library.kind === 'none'
              ? (library?.reason ?? 'Select a topic first.')
              : undefined
          }
          onClick={() => library && library.kind !== 'none' && onShow(library)}
          data-testid="topic-show"
        >
          Show highlights
        </Button>
        {library?.kind === 'search' && library.used < library.total ? (
          <span className="sv-small sv-muted">
            The search box holds {library.used} of its {library.total} banks and tags.
          </span>
        ) : null}
      </div>
    </section>
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
  options,
  selected,
  max,
  loaded,
  onChange,
  testId,
}: {
  legend: string;
  noun: 'bank' | 'tag';
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
  const shown = options.filter((o) => needle === '' || o.name.toLowerCase().includes(needle));
  const atMax = selected.length >= max;
  const toggle = (id: string) =>
    onChange(chosen.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <fieldset className="syl-picker" data-testid={testId}>
      <legend>
        {legend}{' '}
        <span className="sv-small sv-muted">
          ({selected.length} of {max})
        </span>
      </legend>
      {options.length > 8 ? (
        <div className="sv-field">
          <label className="sv-label" htmlFor={filterId}>
            Find a {noun}
          </label>
          <input
            id={filterId}
            type="search"
            className="sv-control"
            value={filter}
            autoComplete="off"
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      ) : null}
      <div className="syl-picker__list">
        {missing.map((id) => (
          <label key={id} className="sv-check">
            <input type="checkbox" checked onChange={() => toggle(id)} />
            <span className="syl-error">
              A {noun} that is deleted or in the trash (untick to remove)
            </span>
          </label>
        ))}
        {shown.slice(0, SHOWN).map((o) => {
          const on = chosen.has(o.id);
          return (
            <label key={o.id} className="sv-check">
              <input
                type="checkbox"
                checked={on}
                disabled={atMax && !on}
                onChange={() => toggle(o.id)}
              />
              <span dir="auto">{o.name}</span>
            </label>
          );
        })}
      </div>
      {loaded && options.length === 0 ? (
        <p className="sv-small sv-muted">You have no {noun}s yet.</p>
      ) : null}
      {shown.length > SHOWN ? (
        <p className="sv-small sv-muted">
          Showing the first {SHOWN} of {shown.length}. Type in the box to narrow the list.
        </p>
      ) : null}
      {atMax ? (
        <p className="sv-small sv-muted">
          A topic points at most {max} {noun}s. Untick one to choose another.
        </p>
      ) : null}
    </fieldset>
  );
}

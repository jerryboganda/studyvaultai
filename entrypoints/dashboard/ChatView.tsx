import './chat.css';
import { useEffect, useId, useRef, useState } from 'react';
import {
  Check,
  MessagesSquare,
  NotebookText,
  Plus,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react';
import {
  createChatThread,
  deleteAiResult,
  deleteChatThread,
  getChatTurns,
  listChatThreads,
  updateChatThread,
  type ChatThread,
  type ChatTurn,
} from '@storage';
import type { AiRequestPreview, AiSelection } from '@ai';
import { BuddyEmptyState, InlineNotice, VaultBuddy, useAction, useAsync, useDataEpoch } from '@ui';
import {
  AiResultCard,
  configSecrets,
  describeAiError,
  previewAiTask,
  requestEndpointAccess,
  retrieveForChat,
  routeFor,
  runAiTask,
  sendBlocker,
  useAiConfig,
  useAiEnv,
  useAiFlag,
  type AiChatPassage,
} from '@ui/ai';
import { EMPTY_FILTERS, toSearchQuery, type Scope } from './filters';
import { Action, Chip, ViewHead } from './moreKit';
import type { SearchLike } from './results';

export interface ChatViewProps {
  /** The dashboard's search index; null while it is restoring or rebuilding. */
  index: SearchLike | null;
  /** The bank or folder chosen in the tree. */
  scope: Scope;
  names: { bank: string | null; folder: string | null };
  tags: readonly { id: string; name: string }[];
}

/** Messages longer than this are refused (the engine's own limit is higher). */
const MAX_MESSAGE = 4000;
/** Turns after this many unsummarised ones are folded into the rolling summary. */
const SUMMARISE_ABOVE = 6;
/** Turns kept word for word after a summary. */
const KEEP_RECENT = 3;
/** Earlier turns sent with a message (the schema allows 12 messages = 6 turns). */
const SEND_TURNS = 6;
const SUMMARY_ASK =
  'Summarise our conversation so far in under 150 words. Keep names, facts, decisions and open questions so that we can continue it later.';

const clip = (text: string, n: number): string =>
  text.length > n ? `${text.slice(0, n - 1)}…` : text;

/** Turns the summary does not cover yet, oldest first. */
const recentTurns = (turns: readonly ChatTurn[], thread: ChatThread | null): ChatTurn[] =>
  thread?.summarizedUpTo ? turns.filter((t) => t.createdAt > thread.summarizedUpTo!) : [...turns];

function historyOf(turns: readonly ChatTurn[]): NonNullable<AiSelection['history']> {
  return turns.slice(-SEND_TURNS).flatMap((t) => {
    if (t.kind !== 'chat' || !t.question) return [];
    return [
      { role: 'user' as const, text: clip(t.question, 2000) },
      { role: 'assistant' as const, text: clip(t.output.answer, 2000) },
    ];
  });
}

const SUGGESTIONS = [
  'Explain the main ideas in my notes on this topic in simple words',
  'Quiz me with three questions',
  'What should I revise first for an exam?',
] as const;

/**
 * Chat: a conversation with the AI provider you set up. It works with no study material at all,
 * and when you have notes it finds the relevant highlights and notes on this device and offers
 * them as cited sources. Conversations are saved here, resume after a reload, and carry a rolling
 * summary so the assistant keeps context. Each conversation asks once what it may send; the exact
 * text of every message stays one click away.
 */
export function ChatView({ index, scope, names, tags }: ChatViewProps) {
  const uid = useId();
  const env = useAiEnv();
  const flag = useAiFlag();
  const cfg = useAiConfig(flag.on);
  const epoch = useDataEpoch();
  const threadsQ = useAsync(() => listChatThreads(), [], [epoch]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const turnsQ = useAsync(
    () => (activeId ? getChatTurns(activeId) : Promise.resolve([] as ChatTurn[])),
    [activeId],
    [epoch],
  );
  const [message, setMessage] = useState('');
  const [useNotes, setUseNotes] = useState(true);
  const [tagId, setTagId] = useState('');
  const [phase, setPhase] = useState<'idle' | 'finding' | 'waiting'>('idle');
  const [note, setNote] = useState<{ tone: 'info' | 'warning' | 'error'; text: string } | null>(
    null,
  );
  const [consent, setConsent] = useState<{
    threadId: string;
    selection: AiSelection;
    preview: AiRequestPreview;
    passages: AiChatPassage[];
    text: string;
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const threads = threadsQ.data ?? [];
  const active = threads.find((t) => t.id === activeId) ?? null;
  const turns = turnsQ.data ?? [];
  const tag = tags.find((t) => t.id === tagId);
  const where = names.folder
    ? `the folder "${names.folder}"`
    : names.bank
      ? `the bank "${names.bank}"`
      : 'all your highlights and notes';
  const busy = phase !== 'idle';

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [turns.length, phase, consent]);

  const blocker = ((): string | null => {
    if (!flag.known || !cfg.data) return 'Reading the AI settings…';
    const config = sendBlocker(cfg.data, env, 'chat');
    if (config) return config;
    if (message.trim() === '') return 'Type a message first.';
    if (message.trim().length > MAX_MESSAGE)
      return `The message is longer than ${MAX_MESSAGE} characters.`;
    return null;
  })();

  /** Sends one prepared request and saves the answer in the thread. */
  const perform = async (
    threadId: string,
    selection: AiSelection,
    preview: AiRequestPreview,
    text: string,
  ) => {
    const config = cfg.data;
    if (!config) return;
    setPhase('waiting');
    abort.current = new AbortController();
    try {
      await runAiTask(config, env, {
        kind: 'chat',
        selection,
        preview,
        threadId,
        signal: abort.current.signal,
      });
      setMessage((m) => (m.trim() === text ? '' : m));
      setNote(null);
      const all = await getChatTurns(threadId);
      const fresh = (await listChatThreads()).find((t) => t.id === threadId) ?? null;
      threadsQ.refresh();
      turnsQ.refresh();
      await foldIntoSummary(threadId, all, fresh);
    } catch (e) {
      const view = describeAiError(e, configSecrets(config));
      setNote({
        tone: view.code === 'aborted' ? 'info' : 'error',
        text:
          view.code === 'aborted'
            ? 'Stopped. Nothing was saved.'
            : `${view.title}: ${view.message}${view.hint ? ` ${view.hint}` : ''}`,
      });
    } finally {
      abort.current = null;
      setPhase('idle');
    }
  };

  /** The rolling memory: older turns become a short summary, sent with every later message. */
  const foldIntoSummary = async (
    threadId: string,
    all: readonly ChatTurn[],
    thread: ChatThread | null,
  ) => {
    const config = cfg.data;
    if (!config) return;
    const recent = recentTurns(all, thread);
    if (recent.length <= SUMMARISE_ABOVE) return;
    const old = recent.slice(0, recent.length - KEEP_RECENT);
    const selection: AiSelection = {
      chunks: [],
      question: SUMMARY_ASK,
      history: historyOf(old),
      ...(thread?.summary ? { memory: thread.summary } : {}),
    };
    try {
      const preview = await previewAiTask(config, env, 'chat', selection);
      const done = await runAiTask(config, env, { kind: 'chat', selection, preview });
      const summary = done.saved.kind === 'chat' ? done.saved.output.answer : '';
      // The summary is memory, not a message of the conversation: it is not kept as a turn.
      await deleteAiResult(done.saved.id).catch(() => undefined);
      if (summary) {
        await updateChatThread(threadId, {
          summary: clip(summary, 4000),
          summarizedUpTo: old.at(-1)!.createdAt,
        });
        threadsQ.refresh();
      }
    } catch {
      // Memory is a convenience: the next message simply carries more recent turns.
    }
  };

  const submit = useAction(async () => {
    const config = cfg.data;
    const text = message.trim();
    if (!config || blocker || busy) return;
    setNote(null);
    // First await of the submit: Chrome's access prompt needs the user's gesture.
    const patterns = routeFor(config, 'chat').targets.flatMap((t) =>
      t.endpoint.ok ? [t.endpoint.pattern] : [],
    );
    if (patterns.length > 0 && !(await requestEndpointAccess(patterns))) {
      setNote({
        tone: 'warning',
        text: 'Chrome did not allow StudyVault to contact the provider, so nothing was sent.',
      });
      return;
    }
    setPhase('finding');
    try {
      let thread = active;
      if (!thread) {
        const created = await createChatThread();
        thread = { ...created, turns: 0 };
        setActiveId(created.id);
      }
      const earlier = recentTurns(turns, thread);
      let passages: AiChatPassage[] = [];
      if (useNotes && index) {
        const scopeQuery = toSearchQuery(
          '',
          scope,
          { ...EMPTY_FILTERS, tagIds: tag ? [tag.id] : [] },
          { bank: names.bank, folder: names.folder, tags: tag ? [tag.name] : [] },
        );
        // A follow-up like "and its side effects?" borrows the words of the message before it.
        const before = earlier.at(-1)?.question ?? '';
        const found = await retrieveForChat(index, {
          question: `${before} ${text}`.trim(),
          scope: scopeQuery,
          topK: 10,
        });
        passages = found.passages;
      }
      const selection: AiSelection = {
        chunks: passages.map((p) => ({ id: p.id, kind: p.kind, text: p.text })),
        question: text,
        ...(earlier.length > 0 ? { history: historyOf(earlier) } : {}),
        ...(thread.summary ? { memory: thread.summary } : {}),
      };
      const preview = await previewAiTask(config, env, 'chat', selection);
      if (!thread.consentedAt) {
        setConsent({ threadId: thread.id, selection, preview, passages, text });
        setPhase('idle');
        return;
      }
      await perform(thread.id, selection, preview, text);
    } catch (e) {
      const view = describeAiError(e, configSecrets(config));
      setNote({ tone: 'error', text: `${view.title}: ${view.message}` });
      setPhase('idle');
    }
  });

  const accept = useAction(async () => {
    if (!consent) return;
    const c = consent;
    await updateChatThread(c.threadId, { consentedAt: new Date().toISOString() });
    setConsent(null);
    threadsQ.refresh();
    await perform(c.threadId, c.selection, c.preview, c.text);
  });

  const removeThread = useAction(async (id: string) => {
    await deleteChatThread(id);
    if (activeId === id) setActiveId(null);
    setConfirmDelete(null);
    threadsQ.refresh();
  });

  const newChat = () => {
    setActiveId(null);
    setConsent(null);
    setNote(null);
    setMessage('');
  };

  const provider = cfg.data ? routeFor(cfg.data, 'chat').first : null;
  const providerText = provider
    ? `${provider.settings.model || 'no model'}${provider.endpoint.ok ? ` · ${provider.endpoint.host}` : ''}`
    : '';

  return (
    <section
      className="dash-panel mv-view chat"
      aria-labelledby={`${uid}-h`}
      data-testid="chat-view"
    >
      <ViewHead
        icon={MessagesSquare}
        tone="violet"
        title="Chat"
        titleId={`${uid}-h`}
        info="A conversation with your AI provider. It can use your highlights and notes (cited word for word) or plain general knowledge, and it remembers the conversation on this device. Answers are unverified drafts."
        infoLabel="About chat"
      />

      <div className="chat-layout">
        <aside className="chat-threads" aria-label="Conversations">
          <Action
            variant="primary"
            icon={Plus}
            data-testid="chat-new"
            onClick={newChat}
            disabledReason={busy ? 'Wait for the answer first.' : undefined}
          >
            New chat
          </Action>
          <ul className="chat-threads__list" data-testid="chat-threads">
            {threads.map((t) => (
              <li key={t.id} className="chat-thread" data-active={t.id === activeId || undefined}>
                <button
                  type="button"
                  className="chat-thread__open"
                  data-testid="chat-thread"
                  aria-current={t.id === activeId ? 'true' : undefined}
                  disabled={busy}
                  onClick={() => {
                    setActiveId(t.id);
                    setConsent(null);
                    setNote(null);
                  }}
                >
                  <span className="chat-thread__title">{t.title || 'New chat'}</span>
                  <span className="chat-thread__meta">
                    {t.turns} {t.turns === 1 ? 'message' : 'messages'}
                  </span>
                </button>
                {confirmDelete === t.id ? (
                  <span className="chat-thread__confirm">
                    <button
                      type="button"
                      className="chat-thread__yes"
                      data-testid="chat-thread-delete-yes"
                      onClick={() => void removeThread.run(t.id)}
                    >
                      Delete
                    </button>
                    <button type="button" onClick={() => setConfirmDelete(null)}>
                      Keep
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="chat-thread__del"
                    data-testid="chat-thread-delete"
                    aria-label={`Delete the conversation "${t.title || 'New chat'}"`}
                    disabled={busy}
                    onClick={() => setConfirmDelete(t.id)}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {threads.length === 0 ? <p className="mv-line">Your conversations appear here.</p> : null}
        </aside>

        <div className="chat-main">
          <div className="chat-scope">
            <Chip icon={Sparkles} tone="violet">
              <span data-testid="chat-provider">{providerText || 'AI provider'}</span>
            </Chip>
            <label className="chat-scope__notes">
              <input
                type="checkbox"
                data-testid="chat-use-notes"
                checked={useNotes}
                onChange={(e) => setUseNotes(e.target.checked)}
              />
              <span>
                Use my notes (<span data-testid="chat-scope">{where}</span>)
              </span>
            </label>
            {useNotes ? (
              <label className="chat-scope__tag">
                <span className="mv-label">Tag</span>
                <select
                  className="sv-control"
                  data-testid="chat-tag"
                  value={tagId}
                  onChange={(e) => setTagId(e.target.value)}
                >
                  <option value="">Any tag</option>
                  {tags.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>

          {turns.length === 0 && !consent ? (
            <div className="mv-card chat-start">
              <BuddyEmptyState
                pose="wave"
                mascotSize={96}
                title="Ask anything"
                text={
                  index
                    ? 'It works with or without study material. Relevant notes are found on this device and offered as cited sources.'
                    : 'Your notes index is still being built; you can already chat in general terms.'
                }
              />
              <ul className="chat-suggest" aria-label="Ideas">
                {SUGGESTIONS.map((s) => (
                  <li key={s}>
                    <button
                      type="button"
                      className="chat-suggest__btn"
                      onClick={() => setMessage(s)}
                    >
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <ol className="chat-turns" aria-label="Conversation" data-testid="chat-turns">
              {turns.map((t) => (
                <li key={t.id} className="chat-turn" data-testid="chat-turn">
                  <p className="chat-bubble chat-bubble--you">
                    <span className="sv-vh">You: </span>
                    <span className="ai-pre">{t.question}</span>
                  </p>
                  <div className="chat-answer">
                    <span className="chat-answer__avatar" aria-hidden="true">
                      <Sparkles strokeWidth={2.4} />
                    </span>
                    <div className="chat-answer__body">
                      <AiResultCard result={t} />
                      <p className="chat-used" data-testid="chat-used">
                        <NotebookText aria-hidden="true" />
                        {t.inputSourceIds.length > 0
                          ? `${t.inputSourceIds.length} of your notes were sent with this message.`
                          : 'No notes were sent with this message.'}
                      </p>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}

          {consent ? (
            <div
              className="mv-card chat-consent"
              data-testid="chat-consent"
              role="group"
              aria-label="What this chat may send"
            >
              <h3>
                <ShieldCheck aria-hidden="true" /> Before the first message
              </h3>
              <p>
                This conversation will send your messages, a short summary and earlier turns of the
                chat
                {consent.passages.length > 0
                  ? `, and up to ${consent.passages.length} of your highlights and notes that match`
                  : ''}{' '}
                to <strong>{consent.preview.recipients.map((r) => r.model).join(', ')}</strong>
                {consent.preview.recipients[0]?.origin
                  ? ` (${consent.preview.recipients[0].origin})`
                  : ''}
                . Emails, card numbers and similar are replaced first
                {Object.keys(consent.preview.redactionSummary).length > 0
                  ? ` (${Object.values(consent.preview.redactionSummary).reduce((a, b) => a + b, 0)} found in this message)`
                  : ''}
                . You will not be asked again in this conversation.
              </p>
              <details>
                <summary>See the exact text of this first message</summary>
                <pre className="chat-consent__text" data-testid="chat-consent-text">
                  {consent.preview.outboundText}
                </pre>
              </details>
              <div className="chat-compose__bar">
                <Action
                  variant="ghost"
                  data-testid="chat-consent-cancel"
                  onClick={() => setConsent(null)}
                >
                  Not now
                </Action>
                <Action
                  variant="primary"
                  icon={Check}
                  data-testid="chat-consent-accept"
                  aria-busy={accept.busy || undefined}
                  onClick={() => void accept.run()}
                >
                  Send and don’t ask again here
                </Action>
              </div>
            </div>
          ) : null}

          <div role="status" aria-live="polite" className="chat-status">
            {phase !== 'idle' ? (
              <p className="chat-thinking" data-testid="chat-thinking">
                <VaultBuddy pose="think" size={48} />
                <span>
                  {phase === 'finding' ? 'Looking through your notes on this device…' : 'Thinking…'}
                </span>
                {phase === 'waiting' ? (
                  <Action
                    variant="ghost"
                    icon={Square}
                    data-testid="chat-stop"
                    onClick={() => abort.current?.abort()}
                  >
                    Stop
                  </Action>
                ) : null}
              </p>
            ) : null}
            {note ? (
              <InlineNotice tone={note.tone === 'error' ? 'error' : note.tone}>
                <span data-testid="chat-note">{note.text}</span>
              </InlineNotice>
            ) : null}
          </div>
          {submit.error || accept.error ? (
            <InlineNotice tone="error" title="Could not send the message">
              {submit.error ?? accept.error}
            </InlineNotice>
          ) : null}
          <div ref={endRef} />

          <form
            className="mv-card chat-compose"
            onSubmit={(e) => {
              e.preventDefault();
              void submit.run();
            }}
          >
            <label className="mv-label" htmlFor={`${uid}-q`}>
              Your message
            </label>
            <textarea
              id={`${uid}-q`}
              className="sv-control chat-compose__q"
              data-testid="chat-question"
              rows={3}
              maxLength={MAX_MESSAGE}
              value={message}
              disabled={busy}
              placeholder="Ask a question, or press Enter to send"
              aria-describedby={blocker && message.trim() !== '' ? `${uid}-reason` : undefined}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (!blocker && !busy) void submit.run();
                }
              }}
            />
            <div className="chat-compose__bar">
              {blocker && message.trim() !== '' ? (
                <p id={`${uid}-reason`} className="mv-line mv-grow" data-testid="chat-reason">
                  {blocker}
                </p>
              ) : (
                <span className="mv-grow" />
              )}
              <Action
                type="submit"
                variant="primary"
                icon={useNotes ? Search : Send}
                data-testid="chat-ask"
                aria-busy={busy || undefined}
                disabledReason={blocker ?? (busy ? 'Working on the last message.' : undefined)}
              >
                Send
              </Action>
            </div>
          </form>
        </div>
      </div>
    </section>
  );
}

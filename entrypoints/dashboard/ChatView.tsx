import './chat.css';
import { useEffect, useId, useRef, useState } from 'react';
import {
  Check,
  Gauge,
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
  createNote,
  deleteAiResult,
  deleteChatThread,
  getChatTurns,
  listChatThreads,
  updateChatThread,
  type ChatThread,
  type ChatTurn,
} from '@storage';
import type { AiRequestPreview, AiSelection } from '@ai';
import type { AiEffort } from '@storage';
import { BuddyEmptyState, InlineNotice, VaultBuddy, useAction, useAsync, useDataEpoch } from '@ui';
import {
  AiResultCard,
  configSecrets,
  VENDORS,
  contextWindowTokens,
  describeAiError,
  effortsFor,
  fitSelection,
  AI_NOTE_PREFIX,
  highlightIdsInScope,
  loadAiConfig,
  partialAnswer,
  previewAiTask,
  semanticPassages,
  requestEndpointAccess,
  retrieveForChat,
  retrieveStudyItems,
  routeFor,
  runAiTask,
  sendBlocker,
  useAiConfig,
  useAiEnv,
  useAiFlag,
  type AiChatPassage,
  type AiConfig,
  type AiOverrides,
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
/** Earlier turns longer than this (characters) are summarised even before there are many of them. */
const SUMMARISE_CHARS = 9000;
/** Turns shown at first in a long conversation. */
const PAGE_TURNS = 30;
/** Earlier turns sent with a message (the schema allows 12 messages = 6 turns). */
const SEND_TURNS = 6;
const EXPAND_ASK =
  'List up to 8 single search words, separated by commas, that would find study notes relevant to the message below. Put only the words in the answer field and leave evidence empty.';
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
  const [smart, setSmart] = useState(true);
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
    key: string;
    prefer: string | null;
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // The provider, model and effort picked just now: shown at once, saved with the conversation.
  const [pick, setPick] = useState<{
    threadId: string | null;
    profileId: string | null;
    model: string;
    effort: AiEffort;
  } | null>(null);
  // The answer as it arrives (streaming providers) and how long the wait has been.
  const [partial, setPartial] = useState('');
  // Older messages stay folded away in a long conversation until asked for.
  const [showAll, setShowAll] = useState(false);
  // Optional: let the model suggest extra search words before the notes are searched.
  const [expand, setExpand] = useState(false);
  // One short polite announcement when an answer has arrived (the text itself streams silently).
  const [announce, setAnnounce] = useState('');
  // How full the last request was, and what had to be left out to fit the model.
  const [ctx, setCtx] = useState<{ used: number; budget: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [memoryDraft, setMemoryDraft] = useState<{ id: string; text: string } | null>(null);
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
  const stored = active
    ? { profileId: active.profileId, model: active.model, effort: active.effort }
    : { profileId: null as string | null, model: '', effort: '' as AiEffort };
  const choice = pick && pick.threadId === activeId ? pick : { threadId: activeId, ...stored };
  const setChoice = async (patch: Partial<typeof stored>) => {
    setPick({ ...choice, ...patch, threadId: activeId });
    if (active) {
      await updateChatThread(active.id, patch);
      threadsQ.refresh();
    }
  };
  /** The configuration this conversation sends with: the stored one plus its own model and effort. */
  const configFor = async (): Promise<AiConfig | null> => {
    const base = cfg.data;
    if (!base) return null;
    const id = choice.profileId ?? routeFor(base, 'chat').first.id;
    if (!choice.model && choice.effort === '') return base;
    const overrides: AiOverrides = {
      [id]: { ...(choice.model ? { model: choice.model } : {}), reasoningEffort: choice.effort },
    };
    return loadAiConfig(true, env, overrides);
  };

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [turns.length, phase, consent]);
  useEffect(() => {
    if (phase !== 'waiting') return undefined;
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [phase]);

  const left = cfg.data
    ? Math.max(0, cfg.data.settings.limits.maxRequestsPerDay - cfg.data.budget.requests)
    : null;
  const blocker = ((): string | null => {
    if (!flag.known || !cfg.data) return 'Reading the AI settings…';
    const config = sendBlocker(cfg.data, env, 'chat', choice.profileId);
    if (config) return config;
    if (message.trim() === '') return 'Type a message first.';
    if (message.trim().length > MAX_MESSAGE)
      return `The message is longer than ${MAX_MESSAGE} characters.`;
    if (left !== null && left <= 0) {
      return `The daily limit of ${cfg.data.settings.limits.maxRequestsPerDay} AI requests is used up. Raise it in the AI settings, or wait for tomorrow (UTC).`;
    }
    return null;
  })();

  /** Sends one prepared request and saves the answer in the thread. */
  const perform = async (
    config: AiConfig,
    threadId: string,
    selection: AiSelection,
    preview: AiRequestPreview,
    text: string,
    prefer: string | null,
  ) => {
    setPhase('waiting');
    setPartial('');
    setAnnounce('');
    setElapsed(0);
    abort.current = new AbortController();
    const signal = abort.current.signal;
    try {
      // One send per conversation at a time across tabs, so two tabs cannot interleave turns.
      const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
      const send = () =>
        runAiTask(config, env, {
          kind: 'chat',
          selection,
          preview,
          threadId,
          prefer,
          signal,
          onDelta: (soFar) => setPartial(partialAnswer(soFar)),
        });
      await (locks ? locks.request(`sv-chat-${threadId}`, { signal }, send) : send());
      setMessage((m) => (m.trim() === text ? '' : m));
      setNote(null);
      setAnnounce('The answer has arrived.');
      const all = await getChatTurns(threadId);
      const saved = (await listChatThreads()).find((t) => t.id === threadId) ?? null;
      threadsQ.refresh();
      turnsQ.refresh();
      await foldIntoSummary(config, threadId, all, saved, prefer);
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
      setPartial('');
      setPhase('idle');
    }
  };

  /** The rolling memory: older turns become a short summary, sent with every later message. */
  const foldIntoSummary = async (
    config: AiConfig,
    threadId: string,
    all: readonly ChatTurn[],
    thread: ChatThread | null,
    prefer: string | null,
    force = false,
  ) => {
    const recent = recentTurns(all, thread);
    // Fold sooner when the earlier turns are long: they would crowd the notes out of the request.
    const heavy =
      recent.reduce(
        (n, t) => n + (t.question?.length ?? 0) + (t.kind === 'chat' ? t.output.answer.length : 0),
        0,
      ) > SUMMARISE_CHARS && recent.length > KEEP_RECENT + 1;
    if (!force && recent.length <= SUMMARISE_ABOVE && !heavy) return;
    const old = recent.slice(0, Math.max(0, recent.length - KEEP_RECENT));
    if (old.length === 0) return;
    const selection: AiSelection = {
      chunks: [],
      question: SUMMARY_ASK,
      history: historyOf(old),
      ...(thread?.summary ? { memory: thread.summary } : {}),
    };
    try {
      const preview = await previewAiTask(config, env, 'chat', selection, undefined, prefer);
      const done = await runAiTask(config, env, { kind: 'chat', selection, preview, prefer });
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

  /**
   * Optional "smart search": the model suggests a few more search words for the message. Only the
   * message goes out (no notes, no earlier turns), through the same pipeline, consent and budget; the
   * words are used locally to search and the helper result is not kept as a turn.
   */
  const suggestTerms = async (
    config: AiConfig,
    text: string,
    prefer: string | null,
  ): Promise<string> => {
    const selection: AiSelection = {
      chunks: [],
      question: `${EXPAND_ASK}\n\nMessage: ${text}`.slice(0, 4000),
    };
    try {
      const preview = await previewAiTask(config, env, 'chat', selection, undefined, prefer);
      const done = await runAiTask(config, env, { kind: 'chat', selection, preview, prefer });
      const words = done.saved.kind === 'chat' ? done.saved.output.answer : '';
      await deleteAiResult(done.saved.id).catch(() => undefined);
      return words.replace(/[^\p{L}\p{N}, -]+/gu, ' ').slice(0, 200);
    } catch {
      return ''; // a convenience: matching simply uses the message itself
    }
  };

  /** Rebuilds the summary now from every turn except the newest few. */
  const refreshMemory = useAction(async () => {
    if (!active || !cfg.data || busy) return;
    const config = (await configFor()) ?? cfg.data;
    const all = await getChatTurns(active.id);
    setPhase('waiting');
    try {
      await foldIntoSummary(config, active.id, all, active, choice.profileId, true);
    } finally {
      setPhase('idle');
    }
  });

  const submit = useAction(async () => {
    const text = message.trim();
    if (!cfg.data || blocker || busy) return;
    setNote(null);
    const prefer = choice.profileId;
    // First await of the submit: Chrome's access prompt needs the user's gesture.
    const patterns = routeFor(cfg.data, 'chat', prefer).targets.flatMap((t) =>
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
    let config: AiConfig = cfg.data;
    try {
      config = (await configFor()) ?? cfg.data;
      let thread = active;
      if (!thread) {
        const created = await createChatThread();
        // The choice made before the first message becomes the conversation's own.
        const own = { profileId: choice.profileId, model: choice.model, effort: choice.effort };
        await updateChatThread(created.id, own);
        thread = { ...created, ...own, turns: 0 };
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
        const extra = expand ? await suggestTerms(config, text, prefer) : '';
        const asked = `${before} ${text} ${extra}`.trim();
        const found = await retrieveForChat(index, {
          question: asked,
          scope: scopeQuery,
          topK: 10,
        });
        passages = found.passages;
        // Flashcards and knowledge points are not in the search index: matched separately.
        const inScope = await highlightIdsInScope({
          bankId: scope.bankId,
          folderId: scope.folderId,
          tagIds: tag ? [tag.id] : [],
        });
        const study = await retrieveStudyItems(asked, 4, undefined, inScope);
        const seen = new Set(passages.map((p) => p.id));
        passages = [...passages, ...study.filter((p) => !seen.has(p.id))];
        if (smart) {
          // Passages that mean what the question means without sharing its words (on-device model).
          const near = await semanticPassages({
            question: asked,
            bankName: names.bank,
            folderName: names.folder,
            tagName: tag?.name ?? null,
            inScope,
            exclude: new Set(passages.map((p) => p.id)),
          });
          passages = [...passages, ...near].slice(0, 14);
        }
      }
      const wanted: AiSelection = {
        chunks: passages.map((p) => ({ id: p.id, kind: p.kind, text: p.text })),
        question: text,
        ...(earlier.length > 0 ? { history: historyOf(earlier) } : {}),
        ...(thread.summary ? { memory: thread.summary } : {}),
      };
      const chosen = routeFor(config, 'chat', prefer).first;
      const fit = fitSelection(
        wanted,
        contextWindowTokens(chosen.settings.vendor, chosen.settings.model),
      );
      const selection: AiSelection = fit.selection;
      setCtx({ used: fit.usedTokens, budget: fit.budgetTokens });
      if (fit.droppedPassages > 0 || fit.droppedTurns > 0) {
        setNote({
          tone: 'info',
          text: `To fit this model, ${fit.droppedPassages > 0 ? `${fit.droppedPassages} lower-ranked passage${fit.droppedPassages === 1 ? '' : 's'}` : ''}${fit.droppedPassages > 0 && fit.droppedTurns > 0 ? ' and ' : ''}${fit.droppedTurns > 0 ? `${fit.droppedTurns} older message pair${fit.droppedTurns === 1 ? '' : 's'}` : ''} were left out of this request.`,
        });
      }
      const preview = await previewAiTask(config, env, 'chat', selection, undefined, prefer);
      // The agreement covers these recipients; another provider or model asks once more.
      const key = (await env.clock.sha256(JSON.stringify(preview.recipients))).slice(0, 32);
      if (thread.consentedAt && thread.consentedFor === null) {
        // An agreement made before recipients were recorded: keep it and record them now.
        await updateChatThread(thread.id, { consentedFor: key });
        thread = { ...thread, consentedFor: key };
      }
      if (!thread.consentedAt || thread.consentedFor !== key) {
        setConsent({ threadId: thread.id, selection, preview, passages, text, key, prefer });
        setPhase('idle');
        return;
      }
      await perform(config, thread.id, selection, preview, text, prefer);
    } catch (e) {
      const view = describeAiError(e, configSecrets(config));
      setNote({ tone: 'error', text: `${view.title}: ${view.message}` });
      setPhase('idle');
    }
  });

  const accept = useAction(async () => {
    if (!consent) return;
    const c = consent;
    await updateChatThread(c.threadId, {
      consentedAt: new Date().toISOString(),
      consentedFor: c.key,
    });
    setConsent(null);
    threadsQ.refresh();
    const config = (await configFor()) ?? cfg.data;
    if (config) await perform(config, c.threadId, c.selection, c.preview, c.text, c.prefer);
  });

  const removeThread = useAction(async (id: string) => {
    await deleteChatThread(id);
    if (activeId === id) setActiveId(null);
    setConfirmDelete(null);
    threadsQ.refresh();
  });

  const rename = useAction(async (title: string) => {
    if (!active) return;
    await updateChatThread(active.id, { title });
    threadsQ.refresh();
  });
  const saveMemory = useAction(async (text: string) => {
    if (!active) return;
    await updateChatThread(active.id, {
      summary: text.trim().slice(0, 4000),
      // Clearing the memory makes every turn count as recent again.
      ...(text.trim() === '' ? { summarizedUpTo: null } : {}),
    });
    setMemoryDraft(null);
    threadsQ.refresh();
  });
  /** The conversation as Markdown: what was asked and answered, and what the answers rested on. */
  const asMarkdown = (): string =>
    [
      `# ${active?.title || 'Chat'}`,
      '',
      '> AI-generated conversation, unverified. Quoted passages come from your own notes.',
      '',
      ...turns.flatMap((t) => [
        `**You:** ${t.question ?? ''}`,
        '',
        t.kind === 'chat' ? t.output.answer : '',
        '',
        ...(t.kind === 'chat' ? t.citations.map((c) => `> ${c.quote}`) : []),
        '',
      ]),
    ]
      .join('\n')
      .trim();
  const exportNote = useAction(async () => {
    if (!active || turns.length === 0) return;
    await createNote({
      title: `${AI_NOTE_PREFIX} ${active.title || 'Chat'}`.slice(0, 200),
      body: asMarkdown(),
    });
    setNote({ tone: 'info', text: 'Saved as a note in your vault, marked as an AI conversation.' });
  });
  const downloadMarkdown = () => {
    const url = URL.createObjectURL(new Blob([asMarkdown()], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(active?.title || 'chat').replace(/[^\w-]+/g, '-').slice(0, 40)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const newChat = () => {
    setActiveId(null);
    setConsent(null);
    setNote(null);
    setMessage('');
  };

  const provider = cfg.data ? routeFor(cfg.data, 'chat', choice.profileId).first : null;
  const efforts = provider
    ? effortsFor(provider.settings.vendor, choice.model || provider.settings.model)
    : [];
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
            {left !== null ? (
              <Chip icon={Gauge} tone={left <= 3 ? 'warning' : 'neutral'}>
                <span data-testid="chat-quota">{left} AI requests left today</span>
              </Chip>
            ) : null}
            {ctx ? (
              <Chip tone={ctx.used / ctx.budget > 0.9 ? 'warning' : 'neutral'}>
                <span data-testid="chat-context">
                  Last request used {Math.round((ctx.used / ctx.budget) * 100)}% of its context
                </span>
              </Chip>
            ) : null}
            {cfg.data && cfg.data.profiles.length > 1 ? (
              <label className="chat-scope__tag">
                <span className="mv-label">Provider</span>
                <select
                  className="sv-control"
                  data-testid="chat-profile"
                  value={choice.profileId ?? routeFor(cfg.data, 'chat').first.id}
                  disabled={busy}
                  onChange={(e) => void setChoice({ profileId: e.target.value, model: '' })}
                >
                  {cfg.data.profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id === 'primary' ? 'Main' : p.label}: {p.settings.model || 'no model'}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {provider ? (
              <>
                <label className="chat-scope__tag">
                  <span className="mv-label">Model</span>
                  <input
                    className="sv-control"
                    data-testid="chat-model"
                    list={`${uid}-models`}
                    value={choice.model || provider.settings.model}
                    disabled={busy}
                    onChange={(e) => void setChoice({ model: e.target.value })}
                  />
                  <datalist id={`${uid}-models`}>
                    {VENDORS[provider.settings.vendor].curatedModels.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </label>
                <label className="chat-scope__tag">
                  <span className="mv-label">Reasoning</span>
                  <select
                    className="sv-control"
                    data-testid="chat-effort"
                    value={choice.effort}
                    disabled={busy || efforts.length === 0}
                    onChange={(e) => void setChoice({ effort: e.target.value as AiEffort })}
                  >
                    <option value="">Default</option>
                    {efforts.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
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
              <label className="chat-scope__notes">
                <input
                  type="checkbox"
                  data-testid="chat-smart"
                  checked={smart}
                  onChange={(e) => setSmart(e.target.checked)}
                />
                <span>Match by meaning</span>
              </label>
            ) : null}
            {useNotes ? (
              <label className="chat-scope__notes">
                <input
                  type="checkbox"
                  data-testid="chat-expand"
                  checked={expand}
                  onChange={(e) => setExpand(e.target.checked)}
                />
                <span>Let the AI suggest search words (1 extra request)</span>
              </label>
            ) : null}
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

          {active ? (
            <div className="chat-tools" data-testid="chat-tools">
              <label className="chat-tools__title">
                <span className="sv-vh">Conversation title</span>
                <input
                  className="sv-control"
                  data-testid="chat-title"
                  key={active.id}
                  defaultValue={active.title}
                  maxLength={80}
                  onBlur={(e) => {
                    if (e.target.value.trim() !== active.title) void rename.run(e.target.value);
                  }}
                />
              </label>
              <Action
                variant="ghost"
                data-testid="chat-export-note"
                disabledReason={turns.length === 0 ? 'Nothing to save yet.' : undefined}
                onClick={() => void exportNote.run()}
              >
                Save as a note
              </Action>
              <Action
                variant="ghost"
                data-testid="chat-export-md"
                disabledReason={turns.length === 0 ? 'Nothing to download yet.' : undefined}
                onClick={downloadMarkdown}
              >
                Download .md
              </Action>
              <details className="chat-memory" data-testid="chat-memory">
                <summary>
                  Memory ({active.summary ? 'a summary is kept' : 'nothing summarised yet'})
                </summary>
                <p className="mv-line">
                  Older messages are folded into this short summary and sent with each new message
                  so the assistant keeps context. It is written by the AI: read it, correct it or
                  clear it.
                </p>
                <textarea
                  className="sv-control"
                  data-testid="chat-memory-text"
                  rows={4}
                  maxLength={4000}
                  value={memoryDraft?.id === active.id ? memoryDraft.text : active.summary}
                  onChange={(e) => setMemoryDraft({ id: active.id, text: e.target.value })}
                />
                <div className="chat-compose__bar">
                  <Action
                    variant="ghost"
                    data-testid="chat-memory-refresh"
                    disabledReason={
                      turns.length <= KEEP_RECENT
                        ? 'Not enough messages to summarise yet.'
                        : busy
                          ? 'Wait for the current answer.'
                          : undefined
                    }
                    onClick={() => void refreshMemory.run()}
                  >
                    Refresh memory
                  </Action>
                  <Action
                    variant="ghost"
                    data-testid="chat-memory-clear"
                    disabledReason={active.summary ? undefined : 'There is no summary to clear.'}
                    onClick={() => void saveMemory.run('')}
                  >
                    Clear memory
                  </Action>
                  <Action
                    variant="primary"
                    data-testid="chat-memory-save"
                    disabledReason={
                      memoryDraft?.id === active.id ? undefined : 'Edit the summary first.'
                    }
                    onClick={() => void saveMemory.run(memoryDraft?.text ?? '')}
                  >
                    Save memory
                  </Action>
                </div>
              </details>
            </div>
          ) : null}

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
              {turns.length > PAGE_TURNS && !showAll ? (
                <li className="chat-more">
                  <button
                    type="button"
                    className="chat-suggest__btn"
                    data-testid="chat-show-earlier"
                    onClick={() => setShowAll(true)}
                  >
                    Show {turns.length - PAGE_TURNS} earlier messages
                  </button>
                </li>
              ) : null}
              {(showAll ? turns : turns.slice(-PAGE_TURNS)).map((t) => (
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
                  {phase === 'finding'
                    ? 'Looking through your notes on this device…'
                    : elapsed >= 15
                      ? `Still working… ${elapsed} s. Some providers (like UBAG) drive a real browser and can take a few minutes.`
                      : 'Thinking…'}
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
          {partial ? (
            // Outside the live region: tokens must not be read out one by one.
            <p className="chat-bubble chat-partial" data-testid="chat-partial">
              <span className="sv-vh">Answer so far: </span>
              <span className="ai-pre">{partial}</span>
            </p>
          ) : null}
          <p className="sv-vh" role="status" aria-live="polite" data-testid="chat-announce">
            {announce}
          </p>
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

import { useId, useRef, useState } from 'react';
import { Eraser, ListChecks, MessagesSquare, Search, Send, Sparkles } from 'lucide-react';
import type { StoredAiResult } from '@storage';
import { BuddyEmptyState, InlineNotice, VaultBuddy, useAction } from '@ui';
import {
  AiResultCard,
  ConsentPreviewDialog,
  retrieveForChat,
  sendBlocker,
  useAiConfig,
  useAiEnv,
  useAiFlag,
  type AiChatInput,
  type AiChatTurn,
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

interface Turn {
  question: string;
  saved: StoredAiResult;
}

/** Earlier turns offered with the next question: the three newest, as plain question/answer text. */
function historyOf(turns: readonly Turn[]): AiChatTurn[] {
  return turns.slice(-3).flatMap((t): AiChatTurn[] =>
    t.saved.kind === 'explain' && t.saved.output.answer
      ? [
          { role: 'user', text: t.question },
          { role: 'assistant', text: t.saved.output.answer },
        ]
      : [],
  );
}

/** The three steps of a question, drawn instead of explained: nothing leaves before step 3. */
const STEPS = [
  { icon: Search, label: 'Find passages', tone: 'primary' },
  { icon: ListChecks, label: 'You pick', tone: 'violet' },
  { icon: Send, label: 'Then send', tone: 'success' },
] as const;

/**
 * Chat with the highlights and notes of a bank, folder or tag. Retrieval is a search of the person's
 * own index on this device. What is found is offered in the consent preview, each passage with a
 * checkbox, together with the exact text that would be sent; the answer must cite those passages
 * word for word, and a citation that is not in them is flagged. "Cannot answer from your notes" is
 * an answer. The conversation lives in this page only.
 */
export function ChatView({ index, scope, names, tags }: ChatViewProps) {
  const uid = useId();
  const env = useAiEnv();
  const flag = useAiFlag();
  const cfg = useAiConfig(flag.on);
  const [question, setQuestion] = useState('');
  const [tagId, setTagId] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState<{ question: string; input: AiChatInput } | null>(null);
  const [note, setNote] = useState<{ tone: 'info' | 'warning'; text: string } | null>(null);
  const answered = useRef(false);

  const tag = tags.find((t) => t.id === tagId);
  const where = names.folder
    ? `the folder "${names.folder}"`
    : names.bank
      ? `the bank "${names.bank}"`
      : 'all your highlights and notes';

  const ask = useAction(async () => {
    const text = question.trim();
    if (!index) return;
    setNote(null);
    const scopeQuery = toSearchQuery(
      '',
      scope,
      { ...EMPTY_FILTERS, tagIds: tag ? [tag.id] : [] },
      { bank: names.bank, folder: names.folder, tags: tag ? [tag.name] : [] },
    );
    const found = await retrieveForChat(index, { question: text, scope: scopeQuery });
    if (found.query === null) {
      setNote({
        tone: 'warning',
        text: 'There is nothing to search for in that question. Use a few key words of the topic.',
      });
      return;
    }
    if (found.passages.length === 0) {
      setNote({
        tone: 'info',
        text: `Cannot answer from your notes: none of your highlights or notes in ${where}${tag ? ` with the tag "${tag.name}"` : ''} matches those words, so nothing was sent.`,
      });
      return;
    }
    answered.current = false;
    setPending({
      question: text,
      input: { question: text, passages: found.passages, history: historyOf(turns) },
    });
  });

  const blocker = ((): string | null => {
    if (!flag.known || !cfg.data) return 'Reading the AI settings…';
    const config = sendBlocker(cfg.data, env, 'explain');
    if (config) return config;
    if (!index) return 'Your search index is still being built. This takes a moment.';
    if (question.trim() === '') return 'Type your question first.';
    if (question.trim().length > 500) return 'The question is longer than 500 characters.';
    return null;
  })();

  return (
    <section
      className="dash-panel mv-view chat"
      aria-labelledby={`${uid}-h`}
      data-testid="chat-view"
    >
      <ViewHead
        icon={MessagesSquare}
        tone="violet"
        title="Chat with your notes"
        titleId={`${uid}-h`}
        info="Answers are drafts that must quote your passages word for word; a quote not in them is flagged. When your notes do not answer, it says so. The chat stays in this page only."
        infoLabel="About chat answers"
      />

      <div className="chat-scope">
        <Chip icon={Search} tone="primary">
          Searching
        </Chip>
        <strong className="mv-wrap" data-testid="chat-scope">
          {where}
        </strong>
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
      </div>

      {turns.length === 0 ? (
        <div className="mv-card chat-start">
          <BuddyEmptyState
            pose="wave"
            mascotSize={96}
            title="No questions yet"
            text="Nothing is sent until you press Send."
          />
          <ol className="chat-steps" aria-label="What happens when you ask">
            {STEPS.map((s, i) => {
              const Icon = s.icon;
              return (
                <li key={s.label} className="chat-step">
                  <span className={`chat-step__art sv-art--${s.tone}`} aria-hidden="true">
                    <Icon strokeWidth={2.4} />
                  </span>
                  <span className="chat-step__n" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="chat-step__label">{s.label}</span>
                </li>
              );
            })}
          </ol>
        </div>
      ) : (
        <ol className="chat-turns" aria-label="Conversation" data-testid="chat-turns">
          {turns.map((t) => (
            <li key={t.saved.id} className="chat-turn" data-testid="chat-turn">
              <p className="chat-bubble chat-bubble--you">
                <span className="sv-vh">You asked: </span>
                <span className="ai-pre">{t.question}</span>
              </p>
              <div className="chat-answer">
                <span className="chat-answer__avatar" aria-hidden="true">
                  <Sparkles strokeWidth={2.4} />
                </span>
                <div className="chat-answer__body">
                  {t.saved.kind === 'explain' &&
                  t.saved.output.answerState === 'insufficient_sources' ? (
                    <InlineNotice tone="info" title="Cannot answer from your notes">
                      <span data-testid="chat-cannot-answer">
                        The passages found do not answer this question
                        {t.saved.output.uncertainty ? `: ${t.saved.output.uncertainty}` : '.'}
                      </span>
                    </InlineNotice>
                  ) : null}
                  <AiResultCard result={t.saved} />
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      <div role="status" aria-live="polite" className="chat-status">
        {ask.busy ? (
          <p className="chat-thinking">
            <VaultBuddy pose="think" size={48} />
            <span>Searching your notes on this device…</span>
          </p>
        ) : null}
        {note ? (
          <InlineNotice tone={note.tone}>
            <span data-testid="chat-note">{note.text}</span>
          </InlineNotice>
        ) : null}
      </div>
      {ask.error ? (
        <InlineNotice tone="error" title="Could not search your notes">
          {ask.error}
        </InlineNotice>
      ) : null}

      <form
        className="mv-card chat-compose"
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocker && !ask.busy) void ask.run();
        }}
      >
        <label className="mv-label" htmlFor={`${uid}-q`}>
          Your question
        </label>
        <textarea
          id={`${uid}-q`}
          className="sv-control chat-compose__q"
          data-testid="chat-question"
          rows={3}
          maxLength={500}
          value={question}
          disabled={ask.busy}
          placeholder="What causes heart failure?"
          aria-describedby={blocker && question.trim() !== '' ? `${uid}-reason` : undefined}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <div className="chat-compose__bar">
          {blocker && question.trim() !== '' ? (
            <p id={`${uid}-reason`} className="mv-line mv-grow" data-testid="chat-reason">
              {blocker}
            </p>
          ) : (
            <span className="mv-grow" />
          )}
          <Action
            variant="ghost"
            icon={Eraser}
            data-testid="chat-clear"
            disabledReason={turns.length === 0 ? 'There is no conversation to clear.' : undefined}
            onClick={() => {
              setTurns([]);
              setNote(null);
            }}
          >
            Clear chat
          </Action>
          <Action
            type="submit"
            variant="primary"
            icon={Search}
            data-testid="chat-ask"
            aria-busy={ask.busy || undefined}
            disabledReason={blocker ?? (ask.busy ? 'Searching already.' : undefined)}
          >
            Find passages
          </Action>
        </div>
      </form>

      {pending && cfg.data ? (
        <ConsentPreviewDialog
          kind="explain"
          highlights={[]}
          chat={pending.input}
          config={cfg.data}
          onClose={() => {
            setPending(null);
            if (answered.current) setQuestion('');
          }}
          onResult={(saved) => {
            answered.current = true;
            setTurns((list) =>
              list.some((t) => t.saved.id === saved.id)
                ? list
                : [...list, { question: pending.question, saved }],
            );
          }}
        />
      ) : null}
    </section>
  );
}

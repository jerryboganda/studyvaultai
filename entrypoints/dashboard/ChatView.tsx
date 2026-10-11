import { useId, useRef, useState } from 'react';
import type { StoredAiResult } from '@storage';
import { Button, EmptyState, InlineNotice, useAction } from '@ui';
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
    <section className="sv-stack" aria-labelledby={`${uid}-h`} data-testid="chat-view">
      <h2 id={`${uid}-h`}>Chat with your notes (AI)</h2>
      <p>
        Ask a question and StudyVault finds the best-matching highlights and notes of{' '}
        <strong data-testid="chat-scope">{where}</strong> on this device. You then see exactly which
        passages and which text would be sent to your AI provider, can untick any of them, and
        nothing is sent until you press Send. Choose a bank, folder or tag to narrow what is
        searched.
      </p>
      <p className="sv-muted sv-small">
        Answers are drafts: each one must quote your passages word for word, quotes that are not in
        them are flagged, and when your notes do not answer the question the answer says so. Study
        aid: verify against authoritative references.
      </p>

      <div className="sv-field">
        <label className="sv-label" htmlFor={`${uid}-tag`}>
          Only passages with this tag (optional)
        </label>
        <select
          id={`${uid}-tag`}
          className="sv-control ai-narrow"
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
      </div>

      <form
        className="sv-stack sv-stack--tight"
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocker && !ask.busy) void ask.run();
        }}
      >
        <div className="sv-field">
          <label className="sv-label" htmlFor={`${uid}-q`}>
            Your question
          </label>
          <textarea
            id={`${uid}-q`}
            className="sv-control"
            data-testid="chat-question"
            rows={3}
            maxLength={500}
            value={question}
            disabled={ask.busy}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </div>
        <div className="sv-row sv-wrap">
          <Button
            type="submit"
            variant="primary"
            data-testid="chat-ask"
            busy={ask.busy}
            {...(blocker ? { disabledReason: blocker } : {})}
          >
            Find passages and preview
          </Button>
          <Button
            data-testid="chat-clear"
            {...(turns.length === 0
              ? { disabledReason: 'There is no conversation to clear.' }
              : {})}
            onClick={() => {
              setTurns([]);
              setNote(null);
            }}
          >
            Clear this conversation
          </Button>
        </div>
        {blocker && question.trim() !== '' ? (
          <p className="sv-muted sv-small" data-testid="chat-reason">
            {blocker}
          </p>
        ) : null}
      </form>

      <div role="status" aria-live="polite">
        {ask.busy ? <p>Searching your notes on this device…</p> : null}
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

      {turns.length === 0 ? (
        <EmptyState title="No questions yet">
          Your conversation stays in this page. Earlier turns are only ever sent when you tick them
          in the preview.
        </EmptyState>
      ) : (
        <ol className="ai-list" aria-label="Conversation" data-testid="chat-turns">
          {turns.map((t) => (
            <li key={t.saved.id} className="sv-stack sv-stack--tight" data-testid="chat-turn">
              <p>
                <strong>You asked:</strong> <span className="ai-pre">{t.question}</span>
              </p>
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
            </li>
          ))}
        </ol>
      )}

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

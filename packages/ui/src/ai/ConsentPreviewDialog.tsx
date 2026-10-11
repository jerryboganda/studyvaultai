import './ai.css';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  checkBudget,
  type AiRequestPreview,
  type AiSelection,
  type AiTaskKind,
  type LogEvent,
  type RedactionEdits,
} from '@ai';
import type { StoredAiResult } from '@storage';
import { Button } from '../Button';
import { useAction, useLatest } from '../hooks';
import { InlineNotice } from '../Notice';
import { AiResultCard } from './AiResultCard';
import { useAiEnv } from './context';
import { AI_KIND_INFO, describeAiError, type AiErrorView } from './labels';
import { hasEndpointAccess, requestEndpointAccess } from './permission';
import {
  configSecrets,
  previewAiTask,
  runAiTask,
  sendBlocker,
  type AiConfig,
  type AiRunDone,
} from './runtime';

/** The part of a highlight the AI actions need. HighlightView and HighlightListItem.highlight fit. */
export interface AiHighlightInput {
  id: string;
  exactQuote: string;
}

const MAX_CHUNKS = 50;
const usd = (n: number) => `$${n.toFixed(n < 0.01 && n > 0 ? 4 : 2)}`;

const REGION_LABEL: Record<string, string> = {
  url_secret: 'link with a secret',
  api_key: 'key or token',
  email: 'email address',
  card: 'card number',
  national_id: 'ID number',
  phone: 'phone number',
  manual: 'your own redaction',
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

interface Built {
  selection?: AiSelection;
  blocker?: string;
}

function buildSelection(
  kind: AiTaskKind,
  highlights: readonly AiHighlightInput[],
  question: string,
  topicsText: string,
  config: AiConfig,
): Built {
  if (highlights.length === 0) return { blocker: 'Select at least one highlight.' };
  if (highlights.length > MAX_CHUNKS) {
    return { blocker: `Select at most ${MAX_CHUNKS} highlights for one request.` };
  }
  const selection: AiSelection = {
    chunks: highlights.map((h) => ({ id: h.id, kind: 'highlight' as const, text: h.exactQuote })),
  };
  const prefs = config.settings.preferences;
  if (kind === 'flashcards') selection.options = { count: prefs.flashcardCount };
  if (kind === 'mcq') selection.options = { choiceCount: prefs.mcqChoices };
  if (kind === 'explain') {
    const q = question.trim();
    if (!q) return { blocker: 'Type your question to build the preview.' };
    if (q.length > 500) return { blocker: 'The question is longer than 500 characters.' };
    selection.question = q;
  }
  if (kind === 'compare_topics' && topicsText.trim()) {
    const topics = topicsText
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (topics.length < 2 || topics.length > 6 || topics.some((t) => t.length > 80)) {
      return {
        blocker:
          'Enter 2 to 6 topic names (up to 80 characters each) separated by commas, or leave the field empty.',
      };
    }
    selection.topics = topics;
  }
  return { selection };
}

function progressText(e: LogEvent): string | null {
  switch (e.event) {
    case 'retry':
      return `The provider did not accept the request yet; trying again (${e.detail ?? ''}).`;
    case 'repair':
      return 'The answer did not match the required format; asking once more.';
    case 'cache_hit':
      return 'An identical earlier answer was reused; nothing was sent.';
    case 'cache_put_failed':
      return 'The answer could not be cached on this device.';
    default:
      return null;
  }
}

export interface ConsentPreviewDialogProps {
  kind: AiTaskKind;
  highlights: readonly AiHighlightInput[];
  /** A configuration read while the feature flag is on (see useAiConfig). */
  config: AiConfig;
  onClose(): void;
  /** The result was produced and stored (it is also shown in the dialog). */
  onResult?(result: StoredAiResult): void;
}

/**
 * The one place a request can leave the device. It shows the exact outbound text, what will be
 * redacted (toggle or add), the estimate, and where it goes. The consent token is created only when
 * "Send" is clicked, from the preview that is on screen; Cancel aborts the request.
 */
export function ConsentPreviewDialog({
  kind,
  highlights,
  config,
  onClose,
  onResult,
}: ConsentPreviewDialogProps) {
  const env = useAiEnv();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const questionId = useId();
  const topicsId = useId();
  const phraseId = useId();
  const info = AI_KIND_INFO[kind];

  const [question, setQuestion] = useState('');
  const [topicsText, setTopicsText] = useState('');
  const [keep, setKeep] = useState<string[]>([]);
  const [add, setAdd] = useState<{ chunkId: string; start: number; end: number }[]>([]);
  const [phrase, setPhrase] = useState('');
  const [phraseMsg, setPhraseMsg] = useState<string | null>(null);

  // The preview that was built for exactly the current input, edits and configuration (see below).
  const [builtPreview, setBuilt] = useState<{
    key: string;
    config: AiConfig;
    preview: AiRequestPreview | null;
    error: AiErrorView | null;
  } | null>(null);
  const [phase, setPhase] = useState<'review' | 'sending' | 'done'>('review');
  const [failure, setFailure] = useState<AiErrorView | null>(null);
  const [done, setDone] = useState<AiRunDone | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [accessRec, setAccessRec] = useState<{ pattern: string; value: boolean } | null>(null);
  const abort = useRef<AbortController | null>(null);

  const built = buildSelection(kind, highlights, question, topicsText, config);
  const edits = useMemo<RedactionEdits>(() => ({ keep, add }), [keep, add]);
  const previewKey = JSON.stringify([built, edits]);
  const latest = useLatest({ built, highlights });
  const secrets = configSecrets(config);

  // Rebuilt locally whenever the input or a redaction choice changes. A preview built for older
  // input is never shown or sent: it is dropped until the one for the current input is ready.
  useEffect(() => {
    const selection = latest.current.built.selection;
    if (!selection) return undefined;
    let live = true;
    const editsNow = JSON.parse(previewKey)[1] as RedactionEdits;
    previewAiTask(config, env, kind, selection, editsNow).then(
      (preview) => {
        if (live) setBuilt({ key: previewKey, config, preview, error: null });
      },
      (e: unknown) => {
        if (live) {
          setBuilt({
            key: previewKey,
            config,
            preview: null,
            error: describeAiError(e, configSecrets(config)),
          });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [previewKey, config, env, kind, latest]);
  // While a newer preview is being built the previous one stays on screen (so focus is not lost),
  // but only a preview built for exactly the current input may be sent.
  const shown = built.selection && builtPreview?.config === config ? builtPreview : null;
  const upToDate = shown !== null && shown.key === previewKey;
  const preview = shown?.preview ?? null;
  const previewError = shown?.error ?? null;

  const pattern = config.endpoint.ok ? config.endpoint.pattern : null;
  const access = pattern && accessRec?.pattern === pattern ? accessRec.value : null;
  const setAccess = (value: boolean) => {
    if (pattern) setAccessRec({ pattern, value });
  };
  useEffect(() => {
    if (!pattern) return undefined;
    let live = true;
    void hasEndpointAccess(pattern).then((v) => live && setAccessRec({ pattern, value: v }));
    return () => {
      live = false;
    };
  }, [pattern]);

  // Native modal dialog: focus is trapped and the page behind is inert (same approach as ConfirmDialog).
  useEffect(() => {
    const el = dialog.current;
    if (!el) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof el.showModal === 'function') el.showModal();
    else el.setAttribute('open', '');
    return () => {
      abort.current?.abort();
      if (typeof el.close === 'function' && el.open) el.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    if (phase !== 'sending') return undefined;
    const t = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const send = useAction(async () => {
    if (!preview || !upToDate || !built.selection) return;
    const selection = built.selection;
    const controller = new AbortController();
    abort.current = controller;
    setFailure(null);
    setNotes([]);
    setElapsed(0);
    setPhase('sending');
    try {
      // First await of the click: Chrome only shows the permission prompt for a user gesture.
      if (pattern && preview.willSend && !(await requestEndpointAccess(pattern))) {
        setAccess(false);
        setFailure({
          code: 'permission_denied',
          title: 'Access to the provider was not granted',
          message: `Chrome did not allow StudyVault to contact ${
            config.endpoint.ok ? config.endpoint.origin : 'the provider'
          }, so nothing was sent.`,
          details: [],
          retryAfterSec: null,
          hint: 'Choose Send again and allow the access in Chrome’s prompt, or cancel.',
        });
        setPhase('review');
        return;
      }
      setAccess(true);
      const result = await runAiTask(config, env, {
        kind,
        selection,
        preview,
        edits,
        signal: controller.signal,
        onProgress: (e) => {
          const text = progressText(e);
          if (text) setNotes((n) => [...n, text]);
        },
      });
      setDone(result);
      setPhase('done');
      onResult?.(result.saved);
    } catch (e) {
      setFailure(describeAiError(e, secrets));
      setPhase('review');
    } finally {
      abort.current = null;
    }
  });

  const toggleRegion = (
    id: string,
    origin: 'auto' | 'manual',
    replace: boolean,
    r: {
      chunkId: string;
      start: number;
      end: number;
    },
  ) => {
    if (origin === 'manual') {
      if (!replace) {
        setAdd((list) =>
          list.filter((a) => !(a.chunkId === r.chunkId && a.start === r.start && a.end === r.end)),
        );
      }
      return;
    }
    setKeep((list) => (replace ? list.filter((x) => x !== id) : [...new Set([...list, id])]));
  };

  const redactPhrase = () => {
    const needle = phrase.trim();
    if (!needle || !preview) return;
    const found: { chunkId: string; start: number; end: number }[] = [];
    for (const chunk of preview.chunks) {
      let at = chunk.text.indexOf(needle);
      while (at >= 0) {
        found.push({ chunkId: chunk.id, start: at, end: at + needle.length });
        at = chunk.text.indexOf(needle, at + needle.length);
      }
    }
    if (found.length === 0) {
      setPhraseMsg('That text does not appear in what would be sent.');
      return;
    }
    setAdd((list) => [...list, ...found]);
    setPhrase('');
    setPhraseMsg(`${found.length} occurrence${found.length === 1 ? '' : 's'} will be replaced.`);
  };

  // Why "Send" is unavailable, in the order the person can fix things.
  const reason = ((): string | null => {
    if (built.blocker) return built.blocker;
    if (previewError) return `The preview could not be built: ${previewError.message}`;
    if (!preview) return 'Preparing the preview…';
    if (!upToDate) return 'Updating the preview…';
    const blocked = sendBlocker(config, env);
    if (blocked) return blocked;
    const d = checkBudget(config.budget, config.settings.limits, env.clock.now(), {
      requests: preview.willSend ? 1 : 0,
      estimatedCostUsd: preview.estimate.estimatedCostUsd,
    });
    if (d.ok) return null;
    if (d.reason === 'requests') {
      return 'The daily request limit is reached. Raise it in the AI settings or try after UTC midnight.';
    }
    if (d.reason === 'cost') {
      return 'This request could pass the daily cost limit (estimate shown below).';
    }
    return 'A daily cost limit is set but no pricing is configured. Add pricing or clear the limit in the AI settings.';
  })();

  const host = config.endpoint.ok ? config.endpoint.host : 'the provider';
  const origin = config.endpoint.ok ? config.endpoint.origin : 'an address that is not set up';
  const local = preview !== null && !preview.willSend;
  const sending = phase === 'sending';

  return (
    <dialog
      ref={dialog}
      className="sv-dialog ai-dialog"
      aria-labelledby={titleId}
      data-testid="ai-consent-dialog"
      onCancel={(e) => {
        e.preventDefault();
        if (sending) abort.current?.abort();
        else onClose();
      }}
    >
      <div className="sv-dialog__body sv-stack">
        <h2 id={titleId}>AI: {info.label}</h2>

        {phase === 'done' && done ? (
          <>
            <InlineNotice tone="success" live title="Done">
              {done.attempts === 0
                ? 'Nothing was sent: the result was computed or reused on this device.'
                : `Answer received from ${host} in ${done.attempts} request${done.attempts === 1 ? '' : 's'}.`}{' '}
              It is stored as an unverified draft; nothing has been added to your vault yet.
            </InlineNotice>
            <AiResultCard result={done.saved} />
            <div className="sv-row">
              <Button variant="primary" data-testid="ai-close" onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="ai-box ai-box--target" data-testid="ai-endpoint-line">
              {local ? (
                <p>
                  <strong>Nothing will be sent.</strong> The answer is computed on this device.
                </p>
              ) : (
                <p>
                  <strong>This will be sent to {origin}</strong>
                </p>
              )}
              <p className="sv-small">
                Provider: {config.provider?.id ?? 'not set up'} · Model:{' '}
                {config.settings.model || 'not set'} ·{' '}
                {config.key.state === 'present'
                  ? `API key saved (${config.key.mask ?? 'hidden'}), sent only to this address`
                  : config.key.state === 'not_needed'
                    ? 'no API key needed for this local address'
                    : 'no usable API key saved'}
              </p>
              {!local && access === false ? (
                <p className="sv-small">
                  Chrome will first ask you to let StudyVault contact {host}. The permission applies
                  to that address only and you can remove it in the AI settings.
                </p>
              ) : null}
            </div>

            {kind === 'explain' ? (
              <div className="sv-field">
                <label className="sv-label" htmlFor={questionId}>
                  Your question (sent with the passages)
                </label>
                <textarea
                  id={questionId}
                  className="sv-control"
                  data-testid="ai-question"
                  rows={2}
                  maxLength={500}
                  disabled={sending}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                />
              </div>
            ) : null}
            {kind === 'compare_topics' ? (
              <div className="sv-field">
                <label className="sv-label" htmlFor={topicsId}>
                  Topics to compare, separated by commas (optional)
                </label>
                <input
                  id={topicsId}
                  className="sv-control"
                  data-testid="ai-topics"
                  disabled={sending}
                  value={topicsText}
                  onChange={(e) => setTopicsText(e.target.value)}
                />
              </div>
            ) : null}

            {previewError ? (
              <InlineNotice tone="error" title={previewError.title}>
                {previewError.message}
                {previewError.hint ? ` ${previewError.hint}` : ''}
              </InlineNotice>
            ) : null}

            {preview ? (
              <>
                <section className="sv-stack sv-stack--tight">
                  <h3>
                    {local
                      ? 'What the request contains (not sent)'
                      : 'Exactly what will be sent, word for word'}
                  </h3>
                  <pre
                    className="ai-outbound"
                    tabIndex={0}
                    aria-label="Exact text that will be sent"
                    data-testid="ai-outbound"
                  >
                    {preview.outboundText}
                  </pre>
                </section>

                <section className="sv-stack sv-stack--tight" aria-label="Redactions">
                  <h3>Sensitive-looking text</h3>
                  {preview.redactions.length === 0 ? (
                    <p className="sv-muted" data-testid="ai-no-redactions">
                      Nothing sensitive-looking was found automatically. Detection is a heuristic:
                      read the text above before sending.
                    </p>
                  ) : (
                    <ul className="ai-list" data-testid="ai-redactions">
                      {preview.redactions.map((r) => (
                        <li key={r.id} className="sv-check">
                          <input
                            id={`${r.id}`}
                            type="checkbox"
                            disabled={sending}
                            checked={r.enabled}
                            onChange={(e) => toggleRegion(r.id, r.origin, e.target.checked, r)}
                          />
                          <label htmlFor={`${r.id}`}>
                            Replace <code>{clip(r.original, 60)}</code> with{' '}
                            <code>{r.placeholder}</code>{' '}
                            <span className="sv-muted sv-small">
                              ({REGION_LABEL[r.kind] ?? r.kind}, passage {r.chunkId})
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="sv-row sv-wrap">
                    <div className="sv-field sv-grow">
                      <label className="sv-label" htmlFor={phraseId}>
                        Also remove this text before sending
                      </label>
                      <input
                        id={phraseId}
                        className="sv-control"
                        data-testid="ai-redact-phrase"
                        disabled={sending}
                        value={phrase}
                        onChange={(e) => setPhrase(e.target.value)}
                      />
                    </div>
                    <Button
                      data-testid="ai-redact-add"
                      {...(sending || !phrase.trim()
                        ? {
                            disabledReason: sending
                              ? 'A request is in progress.'
                              : 'Type the text to remove.',
                          }
                        : {})}
                      onClick={redactPhrase}
                    >
                      Replace it
                    </Button>
                  </div>
                  {phraseMsg ? (
                    <p className="sv-muted sv-small" role="status">
                      {phraseMsg}
                    </p>
                  ) : null}
                </section>

                <section aria-label="Size and cost estimate" data-testid="ai-estimate">
                  <h3>Estimate</h3>
                  <p>
                    About {preview.estimate.inputTokens} input tokens ({preview.estimate.inputChars}{' '}
                    characters), at most {preview.estimate.maxOutputTokens} output tokens.{' '}
                    {preview.estimate.estimatedCostUsd === null
                      ? 'Cost: unknown, because no pricing is set in the AI settings.'
                      : `Cost: up to ${usd(preview.estimate.estimatedCostUsd)} by your pricing.`}
                  </p>
                  <p className="sv-muted sv-small">
                    Today: {config.budget.requests} of {config.settings.limits.maxRequestsPerDay}{' '}
                    requests used.
                  </p>
                </section>

                {preview.warnings.length > 0 ? (
                  <ul className="sv-stack sv-stack--tight" data-testid="ai-warnings">
                    {preview.warnings.map((w) => (
                      <li key={w}>
                        <InlineNotice tone="warning">{w}</InlineNotice>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : null}

            {failure ? (
              <div data-testid="ai-error">
                <InlineNotice tone="error" title={failure.title}>
                  <p>{failure.message}</p>
                  {failure.details.length > 0 ? (
                    <ul>
                      {failure.details.map((d) => (
                        <li key={d}>{d}</li>
                      ))}
                    </ul>
                  ) : null}
                  {failure.hint ? <p>{failure.hint}</p> : null}
                </InlineNotice>
              </div>
            ) : null}

            {sending ? (
              <div role="status" aria-live="polite" data-testid="ai-progress" className="ai-box">
                <p>
                  Waiting for {host}… {elapsed} s. Nothing is saved until the answer arrives and
                  passes its checks.
                </p>
                {notes.map((n, i) => (
                  <p key={i} className="sv-muted sv-small">
                    {n}
                  </p>
                ))}
              </div>
            ) : null}

            <div className="sv-row sv-wrap">
              <Button
                variant="primary"
                data-testid="ai-send"
                busy={send.busy}
                {...(reason && !sending ? { disabledReason: reason } : {})}
                onClick={() => void send.run()}
              >
                {local ? 'Run on this device' : `Send to ${host}`}
              </Button>
              <Button
                data-testid="ai-cancel"
                onClick={() => (sending ? abort.current?.abort() : onClose())}
              >
                {sending ? 'Cancel request' : 'Cancel'}
              </Button>
            </div>
            {reason && !sending ? (
              <p className="sv-muted sv-small" data-testid="ai-send-reason">
                {reason}
              </p>
            ) : null}
          </>
        )}
      </div>
    </dialog>
  );
}

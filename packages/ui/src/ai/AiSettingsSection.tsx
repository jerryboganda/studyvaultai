import './ai.css';
import { Suspense, lazy, useEffect, useId, useState } from 'react';
import {
  checkAiEndpoint,
  clearAiApiKey,
  getAiSettings,
  setAiApiKey,
  updateAiSettings,
  type AiProviderId,
  type AiSettings,
} from '@storage';
import { AsyncSwitch } from '../AsyncSwitch';
import { Button } from '../Button';
import { useAction, useAsync, useDataEpoch } from '../hooks';
import { InlineNotice } from '../Notice';
import { useAiEnv } from './context';
import { Field } from './Field';
import { useAiConfig, useAiFlag } from './hooks';
import { describeAiError, type AiErrorView } from './labels';
import { hasEndpointAccess, requestEndpointAccess, revokeEndpointAccess } from './permission';
import { configSecrets, sendBlocker, testAiConnection } from './runtime';
import { UsageLedger } from './UsageLedger';

// Fallback providers and per-task routing: only loaded once the feature is on and this section shows.
const AiRoutingSection = lazy(() =>
  import('./AiRoutingSection').then((m) => ({ default: m.AiRoutingSection })),
);

/** The fields of the primary provider's form: everything but the fallback providers and the routes. */
type PrimarySettings = Omit<AiSettings, 'fallbacks' | 'routes'>;

const PRESETS: { label: string; provider: AiProviderId; baseUrl: string }[] = [
  { label: 'OpenAI', provider: 'openai_compatible', baseUrl: 'https://api.openai.com/v1' },
  {
    label: 'Ollama on this computer',
    provider: 'openai_compatible',
    baseUrl: 'http://localhost:11434/v1',
  },
  {
    label: 'LM Studio on this computer',
    provider: 'openai_compatible',
    baseUrl: 'http://localhost:1234/v1',
  },
  { label: 'Anthropic', provider: 'anthropic', baseUrl: '' },
];

/** The settings as the text the person is typing (blank = unset). */
interface Form {
  provider: AiProviderId;
  baseUrl: string;
  model: string;
  maxRequests: string;
  maxCost: string;
  priceIn: string;
  priceOut: string;
  flashcards: string;
  mcq: string;
  jsonMode: boolean;
  maxTokensParam: AiSettings['maxTokensParam'];
}

const toForm = (s: AiSettings): Form => ({
  provider: s.provider,
  baseUrl: s.baseUrl,
  model: s.model,
  maxRequests: String(s.limits.maxRequestsPerDay),
  maxCost: s.limits.maxCostUsdPerDay === null ? '' : String(s.limits.maxCostUsdPerDay),
  priceIn: s.pricing ? String(s.pricing.inputUsdPerMTok) : '',
  priceOut: s.pricing ? String(s.pricing.outputUsdPerMTok) : '',
  flashcards: String(s.preferences.flashcardCount),
  mcq: String(s.preferences.mcqChoices),
  jsonMode: s.jsonMode,
  maxTokensParam: s.maxTokensParam,
});

const num = (t: string): number => (t.trim() === '' ? Number.NaN : Number(t));

function fromForm(
  f: Form,
): { ok: true; settings: PrimarySettings } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const maxRequests = num(f.maxRequests);
  if (!Number.isInteger(maxRequests) || maxRequests < 0 || maxRequests > 10_000) {
    errors.push('The daily request limit must be a whole number from 0 to 10000.');
  }
  const priceIn = num(f.priceIn);
  const priceOut = num(f.priceOut);
  const anyPrice = f.priceIn.trim() !== '' || f.priceOut.trim() !== '';
  if (anyPrice && (!(priceIn >= 0) || !(priceOut >= 0))) {
    errors.push('Enter both prices (US dollars per million tokens), or leave both empty.');
  }
  const maxCost = f.maxCost.trim() === '' ? null : num(f.maxCost);
  if (maxCost !== null && !(maxCost >= 0)) errors.push('The daily cost limit must be a number.');
  if (maxCost !== null && !anyPrice) {
    errors.push('A daily cost limit needs pricing, otherwise it cannot be enforced.');
  }
  const flashcards = num(f.flashcards);
  if (!Number.isInteger(flashcards) || flashcards < 1 || flashcards > 20) {
    errors.push('Flashcards per request must be from 1 to 20.');
  }
  const mcq = num(f.mcq);
  if (!Number.isInteger(mcq) || mcq < 3 || mcq > 6) {
    errors.push('Answer choices must be from 3 to 6.');
  }
  if (f.baseUrl.trim() !== '') {
    const check = checkAiEndpoint(f.provider, f.baseUrl);
    if (!check.ok) errors.push(check.reason);
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      provider: f.provider,
      baseUrl: f.baseUrl.trim(),
      model: f.model.trim(),
      jsonMode: f.jsonMode,
      maxTokensParam: f.maxTokensParam,
      limits: { maxRequestsPerDay: maxRequests, maxCostUsdPerDay: maxCost },
      pricing: anyPrice ? { inputUsdPerMTok: priceIn, outputUsdPerMTok: priceOut } : null,
      preferences: { flashcardCount: flashcards, mcqChoices: mcq },
    },
  };
}

/**
 * AI settings for the options page: the opt-in flag with what leaves the device, the provider,
 * the key (masked, with an honest storage warning and one-click removal), the endpoint permission,
 * limits and pricing, a real "Test connection", and the usage ledger.
 */
export function AiSettingsSection() {
  const uid = useId();
  const env = useAiEnv();
  const epoch = useDataEpoch();
  const flag = useAiFlag();
  const cfg = useAiConfig(flag.on);
  const saved = useAsync(() => getAiSettings(), [], [epoch]);

  // `draft` is what the person has typed; null = untouched, so the form follows what is stored.
  const [draft, setDraft] = useState<Form | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [keyInput, setKeyInput] = useState('');
  const [accessRec, setAccessRec] = useState<{ pattern: string; value: boolean } | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<
    | { ok: true; reply: string; latencyMs: number; tokens: number }
    | { ok: false; view: AiErrorView }
    | null
  >(null);

  const dirty = draft !== null;
  const form = draft ?? (saved.data ? toForm(saved.data) : null);
  const edit = (patch: Partial<Form>) => {
    if (form) setDraft({ ...form, ...patch });
  };

  const config = cfg.data;
  const endpoint = config?.endpoint;
  const pattern = endpoint?.ok ? endpoint.pattern : null;
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

  const toggle = useAction(async (next: boolean) => {
    await flag.setOn(next);
  });
  const save = useAction(async () => {
    if (!form) return;
    const parsed = fromForm(form);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors([]);
    // Only this form's fields: the fallback providers and the routes are edited in their own section.
    await updateAiSettings((current) => ({ ...current, ...parsed.settings }));
    setDraft(null);
    saved.refresh();
    cfg.refresh();
  });
  const saveKey = useAction(async () => {
    const check = endpoint;
    if (!check?.ok) throw new Error('Save a valid provider address first.');
    await setAiApiKey(keyInput, check.origin);
    setKeyInput('');
    cfg.refresh();
  });
  const removeKey = useAction(async () => {
    await clearAiApiKey();
    cfg.refresh();
  });
  const allow = useAction(async () => {
    if (!pattern) return;
    // First await of the click: the permission prompt needs the user gesture.
    setAccess(await requestEndpointAccess(pattern));
  });
  const revoke = useAction(async () => {
    if (!pattern) return;
    await revokeEndpointAccess(pattern);
    setAccess(await hasEndpointAccess(pattern));
  });

  const runTest = () => {
    if (!config || !pattern || testing) return;
    setTesting(true);
    setTest(null);
    void (async () => {
      try {
        // First await of the click handler (user gesture for the permission prompt).
        const granted = await requestEndpointAccess(pattern);
        setAccess(granted);
        if (!granted) {
          setTest({
            ok: false,
            view: {
              code: 'permission_denied',
              title: 'Access to the provider was not granted',
              message:
                'Chrome did not allow StudyVault to contact the provider, so nothing was sent.',
              details: [],
              retryAfterSec: null,
              hint: 'Run the test again and allow the access in Chrome’s prompt.',
            },
          });
          return;
        }
        const r = await testAiConnection(config, env);
        setTest(
          r.ok
            ? {
                ok: true,
                reply: r.reply,
                latencyMs: r.latencyMs,
                tokens: r.inputTokens + r.outputTokens,
              }
            : { ok: false, view: describeAiError(r.error, configSecrets(config)) },
        );
        cfg.refresh();
      } catch (e) {
        setTest({ ok: false, view: describeAiError(e, configSecrets(config)) });
      } finally {
        setTesting(false);
      }
    })();
  };

  if (!flag.known) return <p className="sv-muted">Reading your settings…</p>;

  const heading = <h2 id={`${uid}-h`}>AI assistance (optional, off by default)</h2>;
  const explain = (
    <div className="sv-stack sv-stack--tight">
      <p>
        While this is off, StudyVault sends nothing anywhere and every other feature works the same.
      </p>
      <p>
        When it is on and you use an AI action, StudyVault sends{' '}
        <strong>only the highlights you selected</strong> (and your question, if you ask one; in
        chat, the notes and earlier turns you tick) to the provider address you set below, or to a
        fallback provider you added, which every confirmation lists. You see the exact text first,
        text that looks like an email, phone number, card number or key is replaced unless you
        choose otherwise, and nothing is sent until you press Send. Your library, notes and browsing
        history are never sent unless you select them.
      </p>
      <p>
        AI results are drafts: labelled unverified, linked to your saved quotes, and never able to
        change a saved quote or one of your notes.
      </p>
    </div>
  );

  // Pending until the setting is written: shown as chosen, busy, never snapping back; a failure
  // rolls back and is the alert notice below.
  const flagBox = (
    <AsyncSwitch
      checked={flag.on}
      testId="ai-enable"
      label="Turn on AI features"
      onChange={(next) => toggle.run(next)}
    />
  );

  if (!flag.on) {
    return (
      <section className="sv-stack" aria-labelledby={`${uid}-h`}>
        {heading}
        {explain}
        {flagBox}
        {toggle.error ? (
          <InlineNotice tone="error" title="The setting was not saved">
            {toggle.error}
          </InlineNotice>
        ) : null}
      </section>
    );
  }

  const blocker = !config
    ? 'Reading the AI settings…'
    : dirty
      ? 'Save your changes first: the test uses the saved settings.'
      : sendBlocker(config, env);
  const keyState = config?.key.state;
  const origin = endpoint?.ok ? endpoint.origin : null;
  const formEndpoint = form ? checkAiEndpoint(form.provider, form.baseUrl) : null;

  return (
    <section className="sv-stack" aria-labelledby={`${uid}-h`}>
      {heading}
      {explain}
      {flagBox}
      {toggle.error ? (
        <InlineNotice tone="error" title="The setting was not saved">
          {toggle.error}
        </InlineNotice>
      ) : null}

      {saved.error ? (
        <InlineNotice tone="error" title="Could not read the AI settings">
          {saved.error}
        </InlineNotice>
      ) : null}

      {form ? (
        <>
          <h3>Provider</h3>
          <div className="sv-row sv-wrap">
            {PRESETS.map((p) => (
              <Button
                key={p.label}
                onClick={() => edit({ provider: p.provider, baseUrl: p.baseUrl })}
              >
                Use {p.label}
              </Button>
            ))}
          </div>
          <Field label="Provider type">
            {(id) => (
              <select
                id={id}
                className="sv-control ai-narrow"
                data-testid="ai-provider"
                value={form.provider}
                onChange={(e) => edit({ provider: e.target.value as AiProviderId })}
              >
                <option value="openai_compatible">
                  OpenAI-compatible (OpenAI, Ollama, LM Studio, …)
                </option>
                <option value="anthropic">Anthropic</option>
              </select>
            )}
          </Field>
          <Field
            label="Provider address"
            hint={
              form.provider === 'anthropic'
                ? 'Leave empty for https://api.anthropic.com.'
                : 'For example https://api.openai.com/v1. Plain http:// works only for http://localhost and http://127.0.0.1.'
            }
          >
            {(id, hintId) => (
              <input
                id={id}
                className="sv-control"
                data-testid="ai-base-url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                aria-describedby={hintId}
                value={form.baseUrl}
                onChange={(e) => edit({ baseUrl: e.target.value })}
              />
            )}
          </Field>
          {formEndpoint &&
          !formEndpoint.ok &&
          (form.baseUrl.trim() !== '' || form.provider === 'openai_compatible') ? (
            <p className="sv-muted sv-small" data-testid="ai-endpoint-status">
              {formEndpoint.reason}
            </p>
          ) : null}
          {formEndpoint?.ok ? (
            <p className="sv-muted sv-small" data-testid="ai-endpoint-status">
              Requests will go to {formEndpoint.origin} only.
            </p>
          ) : null}
          <Field
            label="Model id"
            hint="Copy the model id from your provider. StudyVault does not choose a model for you."
          >
            {(id, hintId) => (
              <input
                id={id}
                className="sv-control ai-narrow"
                data-testid="ai-model"
                autoComplete="off"
                spellCheck={false}
                aria-describedby={hintId}
                value={form.model}
                onChange={(e) => edit({ model: e.target.value })}
              />
            )}
          </Field>

          <h3>API key</h3>
          <InlineNotice tone="warning" title="Where your key is kept">
            The key is stored on this device in the extension&apos;s private browser storage,{' '}
            <strong>without extra encryption</strong>. Anyone who can use this computer account or
            read this browser profile can read it. Use a key with a low spending limit and remove it
            here when you no longer need it. It is sent only to the address above, and never written
            to backups, exports or logs.
          </InlineNotice>
          {config?.key.state === 'present' || config?.key.state === 'other_origin' ? (
            <p data-testid="ai-key-status">
              Saved key: <code data-testid="ai-key-mask">{config.key.mask}</code>
              {config.key.state === 'other_origin'
                ? ` (saved for ${config.key.origin}; it is not used for the current address, enter it again)`
                : ''}
            </p>
          ) : (
            <p className="sv-muted" data-testid="ai-key-status">
              {keyState === 'not_needed'
                ? 'No key saved. A local address does not need one.'
                : 'No key saved.'}
            </p>
          )}
          <div className="sv-row sv-wrap">
            <Field label={keyState === 'present' ? 'Replace key' : 'API key'}>
              {(id) => (
                <input
                  id={id}
                  className="sv-control ai-narrow"
                  data-testid="ai-key-input"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                />
              )}
            </Field>
            <Button
              data-testid="ai-key-save"
              busy={saveKey.busy}
              {...(!endpoint?.ok
                ? { disabledReason: 'Save a valid provider address first: the key is tied to it.' }
                : keyInput.trim() === ''
                  ? { disabledReason: 'Type the key first.' }
                  : {})}
              onClick={() => void saveKey.run()}
            >
              Save key
            </Button>
            <Button
              variant="danger"
              data-testid="ai-key-remove"
              busy={removeKey.busy}
              {...(config?.key.mask === null || config?.key.mask === undefined
                ? { disabledReason: 'There is no saved key to remove.' }
                : {})}
              onClick={() => void removeKey.run()}
            >
              Remove key
            </Button>
          </div>
          {saveKey.error ? (
            <InlineNotice tone="error" title="The key was not saved">
              {saveKey.error}
            </InlineNotice>
          ) : null}
          {removeKey.error ? (
            <InlineNotice tone="error" title="The key was not removed">
              {removeKey.error}
            </InlineNotice>
          ) : null}

          <h3>Access to the provider</h3>
          {origin ? (
            <>
              <p>
                Chrome must let StudyVault contact <strong>{origin}</strong>. StudyVault asks for
                that one address only
                {origin.startsWith('http://') ? ' (Chrome covers every port on this host)' : ''},
                when you press Allow, Send or Test. Status:{' '}
                <span data-testid="ai-access-status">
                  {access === null ? 'checking' : access ? 'allowed' : 'not allowed yet'}
                </span>
                .
              </p>
              <div className="sv-row sv-wrap">
                <Button
                  data-testid="ai-access-allow"
                  busy={allow.busy}
                  {...(access ? { disabledReason: 'Access is already allowed.' } : {})}
                  onClick={() => void allow.run()}
                >
                  Allow access to {endpoint?.ok ? endpoint.host : 'the provider'}
                </Button>
                <Button
                  data-testid="ai-access-revoke"
                  busy={revoke.busy}
                  {...(!access ? { disabledReason: 'Access has not been allowed.' } : {})}
                  onClick={() => void revoke.run()}
                >
                  Remove access
                </Button>
              </div>
              {allow.error || revoke.error ? (
                <InlineNotice tone="error" title="Chrome did not change the access">
                  {allow.error ?? revoke.error}
                </InlineNotice>
              ) : null}
            </>
          ) : (
            <p className="sv-muted">Save a valid provider address to manage access to it.</p>
          )}

          <h3>Daily limits and pricing</h3>
          <div className="sv-row sv-wrap">
            <Field label="Requests per day (UTC)">
              {(id) => (
                <input
                  id={id}
                  className="sv-control ai-number"
                  data-testid="ai-max-requests"
                  inputMode="numeric"
                  value={form.maxRequests}
                  onChange={(e) => edit({ maxRequests: e.target.value })}
                />
              )}
            </Field>
            <Field label="Cost per day, US dollars (optional)">
              {(id) => (
                <input
                  id={id}
                  className="sv-control ai-number"
                  data-testid="ai-max-cost"
                  inputMode="decimal"
                  value={form.maxCost}
                  onChange={(e) => edit({ maxCost: e.target.value })}
                />
              )}
            </Field>
          </div>
          <div className="sv-row sv-wrap">
            <Field label="Input price, $ per million tokens">
              {(id) => (
                <input
                  id={id}
                  className="sv-control ai-number"
                  data-testid="ai-price-in"
                  inputMode="decimal"
                  value={form.priceIn}
                  onChange={(e) => edit({ priceIn: e.target.value })}
                />
              )}
            </Field>
            <Field label="Output price, $ per million tokens">
              {(id) => (
                <input
                  id={id}
                  className="sv-control ai-number"
                  data-testid="ai-price-out"
                  inputMode="decimal"
                  value={form.priceOut}
                  onChange={(e) => edit({ priceOut: e.target.value })}
                />
              )}
            </Field>
          </div>
          <p className="sv-muted sv-small">
            Prices come from your provider&apos;s price list; StudyVault does not know them. Without
            prices, cost estimates read &quot;unknown&quot; and a cost limit cannot be used.
          </p>

          <h3>Preferences</h3>
          <div className="sv-row sv-wrap">
            <Field label="Flashcards per request">
              {(id) => (
                <input
                  id={id}
                  className="sv-control ai-number"
                  inputMode="numeric"
                  value={form.flashcards}
                  onChange={(e) => edit({ flashcards: e.target.value })}
                />
              )}
            </Field>
            <Field label="Answer choices per question">
              {(id) => (
                <input
                  id={id}
                  className="sv-control ai-number"
                  inputMode="numeric"
                  value={form.mcq}
                  onChange={(e) => edit({ mcq: e.target.value })}
                />
              )}
            </Field>
          </div>
          {form.provider === 'openai_compatible' ? (
            <details>
              <summary>Compatibility options</summary>
              <div className="sv-stack sv-stack--tight">
                <label className="sv-check">
                  <input
                    type="checkbox"
                    checked={form.jsonMode}
                    onChange={(e) => edit({ jsonMode: e.target.checked })}
                  />
                  <span>
                    Ask for JSON mode (turn off if your server rejects <code>response_format</code>)
                  </span>
                </label>
                <Field label="Token limit parameter">
                  {(id) => (
                    <select
                      id={id}
                      className="sv-control ai-narrow"
                      value={form.maxTokensParam}
                      onChange={(e) =>
                        edit({ maxTokensParam: e.target.value as Form['maxTokensParam'] })
                      }
                    >
                      <option value="max_tokens">max_tokens (widest support)</option>
                      <option value="max_completion_tokens">max_completion_tokens</option>
                    </select>
                  )}
                </Field>
              </div>
            </details>
          ) : null}

          {errors.length > 0 ? (
            <InlineNotice tone="error" title="Check these settings">
              <ul>
                {errors.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </InlineNotice>
          ) : null}
          {save.error ? (
            <InlineNotice tone="error" title="The settings were not saved">
              {save.error}
            </InlineNotice>
          ) : null}
          <div className="sv-row sv-wrap">
            <Button
              variant="primary"
              data-testid="ai-save-settings"
              busy={save.busy}
              {...(!dirty ? { disabledReason: 'There are no changes to save.' } : {})}
              onClick={() => void save.run()}
            >
              Save settings
            </Button>
            <Button
              data-testid="ai-test"
              busy={testing}
              {...(blocker ? { disabledReason: blocker } : {})}
              onClick={runTest}
            >
              Test connection
            </Button>
          </div>
          <p className="sv-muted sv-small">
            Test connection sends one fixed message (&quot;Reply with the single word: OK&quot;) to{' '}
            {origin ?? 'the provider'}. No study content is sent, and the request is counted in the
            ledger below.
          </p>
          {testing ? (
            <p role="status" data-testid="ai-test-progress">
              Contacting {origin ?? 'the provider'}…
            </p>
          ) : null}
          {test?.ok ? (
            <InlineNotice tone="success" live title="The provider answered">
              <span data-testid="ai-test-result">
                Reply: &quot;{test.reply}&quot; in {test.latencyMs} ms, {test.tokens} tokens.
              </span>
            </InlineNotice>
          ) : null}
          {test && !test.ok ? (
            <div data-testid="ai-test-result">
              <InlineNotice tone="error" title={test.view.title}>
                <p>{test.view.message}</p>
                {test.view.hint ? <p>{test.view.hint}</p> : null}
              </InlineNotice>
            </div>
          ) : null}
        </>
      ) : null}

      <Suspense fallback={<p className="sv-muted">Loading the provider list…</p>}>
        <AiRoutingSection />
      </Suspense>

      <UsageLedger />
    </section>
  );
}

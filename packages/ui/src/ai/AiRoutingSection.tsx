import './ai.css';
import { useId, useState } from 'react';
import {
  AI_MAX_FALLBACKS,
  PRIMARY_PROFILE_ID,
  checkAiEndpoint,
  clearAiProfileApiKey,
  getAiSettings,
  newAiProfileId,
  setAiProfileApiKey,
  updateAiSettings,
  type AiProfile,
  type AiProviderId,
} from '@storage';
import { Route } from 'lucide-react';
import { Button } from '../Button';
import { InfoTip } from '../design/InfoTip';
import { ConfirmDialog } from '../ConfirmDialog';
import { useAction, useAsync, useDataEpoch } from '../hooks';
import { InlineNotice } from '../Notice';
import { useAiEnv } from './context';
import { Field } from './Field';
import { useAiConfig, useAiFlag } from './hooks';
import { AI_ACTION_KINDS, AI_KIND_INFO, describeAiError, type AiErrorView } from './labels';
import { requestEndpointAccess } from './permission';
import {
  configSecrets,
  testAiConnection,
  type AiConfig,
  type AiEnv,
  type AiProfileConfig,
} from './runtime';

/** A fallback provider as the text the person is typing (blank = unset). */
interface Form {
  label: string;
  provider: AiProviderId;
  baseUrl: string;
  model: string;
  priceIn: string;
  priceOut: string;
  fallback: boolean;
  jsonMode: boolean;
  maxTokensParam: AiProfile['maxTokensParam'];
}

const toForm = (p: AiProfile): Form => ({
  label: p.label,
  provider: p.provider,
  baseUrl: p.baseUrl,
  model: p.model,
  priceIn: p.pricing ? String(p.pricing.inputUsdPerMTok) : '',
  priceOut: p.pricing ? String(p.pricing.outputUsdPerMTok) : '',
  fallback: p.fallback,
  jsonMode: p.jsonMode,
  maxTokensParam: p.maxTokensParam,
});

const num = (t: string): number => (t.trim() === '' ? Number.NaN : Number(t));

function fromForm(
  id: string,
  f: Form,
): { ok: true; profile: AiProfile } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const label = f.label.trim();
  if (label === '' || label.length > 40)
    errors.push('Give the provider a name of up to 40 characters.');
  const anyPrice = f.priceIn.trim() !== '' || f.priceOut.trim() !== '';
  const priceIn = num(f.priceIn);
  const priceOut = num(f.priceOut);
  if (anyPrice && (!(priceIn >= 0) || !(priceOut >= 0))) {
    errors.push('Enter both prices (US dollars per million tokens), or leave both empty.');
  }
  if (f.baseUrl.trim() !== '') {
    const check = checkAiEndpoint(f.provider, f.baseUrl);
    if (!check.ok) errors.push(check.reason);
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    profile: {
      id,
      label,
      provider: f.provider,
      baseUrl: f.baseUrl.trim(),
      model: f.model.trim(),
      jsonMode: f.jsonMode,
      maxTokensParam: f.maxTokensParam,
      vendor: 'custom',
      reasoningEffort: '',
      authScheme: 'bearer',
      pricing: anyPrice ? { inputUsdPerMTok: priceIn, outputUsdPerMTok: priceOut } : null,
      fallback: f.fallback,
    },
  };
}

type TestState =
  { ok: true; reply: string; latencyMs: number; tokens: number } | { ok: false; view: AiErrorView };

function ProviderCard({
  profile,
  config,
  env,
  index,
  count,
  onTested,
}: {
  profile: AiProfile;
  /** The configuration as saved, or null while it is being read. */
  config: AiConfig | null;
  env: AiEnv;
  index: number;
  count: number;
  onTested(): void;
}) {
  const uid = useId();
  const [draft, setDraft] = useState<Form | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [keyInput, setKeyInput] = useState('');
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestState | null>(null);
  const [asking, setAsking] = useState(false);

  // The draft stays after a save (the saved row catches up a moment later); it only counts as a
  // change while it differs from what is stored, so the fields never snap back to the old values.
  const stored = toForm(profile);
  const form = draft ?? stored;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(stored);
  const edit = (patch: Partial<Form>) => setDraft({ ...form, ...patch });
  const live: AiProfileConfig | undefined = config?.profiles.find((p) => p.id === profile.id);
  const formEndpoint = checkAiEndpoint(form.provider, form.baseUrl);

  const save = useAction(async () => {
    const parsed = fromForm(profile.id, form);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors([]);
    await updateAiSettings((cur) => ({
      ...cur,
      fallbacks: cur.fallbacks.map((p) => (p.id === profile.id ? parsed.profile : p)),
    }));
    setDraft(toForm(parsed.profile)); // the trimmed values that were stored
  });
  const saveKey = useAction(async () => {
    if (!live?.endpoint.ok) throw new Error('Save a valid provider address first.');
    await setAiProfileApiKey(profile.id, keyInput, live.endpoint.origin);
    setKeyInput('');
  });
  const removeKey = useAction(async () => {
    await clearAiProfileApiKey(profile.id);
  });
  const move = useAction(async (by: -1 | 1) => {
    await updateAiSettings((cur) => {
      const list = [...cur.fallbacks];
      const at = list.findIndex((p) => p.id === profile.id);
      const to = at + by;
      if (at < 0 || to < 0 || to >= list.length) return cur;
      [list[at], list[to]] = [list[to]!, list[at]!];
      return { ...cur, fallbacks: list };
    });
  });
  const remove = useAction(async () => {
    await updateAiSettings((cur) => ({
      ...cur,
      fallbacks: cur.fallbacks.filter((p) => p.id !== profile.id),
    }));
  });

  const blocker = ((): string | null => {
    if (dirty) return 'Save this provider first: the test uses the saved settings.';
    if (!config || !live) return 'Reading the AI settings…';
    if (live.problem) return live.problem;
    if (live.key.state === 'missing') return 'Add this provider’s API key first.';
    if (live.key.state === 'other_origin') {
      return 'The saved API key belongs to another address. Enter the key again.';
    }
    if (live.endpoint.ok && !live.endpoint.loopback && !env.online()) {
      return 'You are offline. AI needs a connection (a model on this computer works offline).';
    }
    return null;
  })();

  const runTest = () => {
    if (!config || !live?.endpoint.ok || testing) return;
    const pattern = live.endpoint.pattern;
    setTesting(true);
    setTest(null);
    void (async () => {
      try {
        // First await of the click handler (user gesture for the permission prompt).
        if (!(await requestEndpointAccess(pattern))) {
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
        const r = await testAiConnection(config, env, undefined, profile.id);
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
        onTested();
      } catch (e) {
        setTest({ ok: false, view: describeAiError(e, config ? configSecrets(config) : []) });
      } finally {
        setTesting(false);
      }
    })();
  };

  const origin = live?.endpoint.ok ? live.endpoint.origin : null;
  const keyState = live?.key.state;

  return (
    <li
      className="ai-box sv-stack sv-stack--tight"
      aria-labelledby={`${uid}-h`}
      data-testid="ai-profile"
      data-profile-id={profile.id}
    >
      <h4 id={`${uid}-h`}>
        {index + 2}. {profile.label}
      </h4>
      <Field label="Name">
        {(id) => (
          <input
            id={id}
            className="sv-control ai-narrow"
            data-testid="ai-profile-label"
            maxLength={40}
            value={form.label}
            onChange={(e) => edit({ label: e.target.value })}
          />
        )}
      </Field>
      <Field label="Provider type">
        {(id) => (
          <select
            id={id}
            className="sv-control ai-narrow"
            data-testid="ai-profile-provider"
            value={form.provider}
            onChange={(e) => edit({ provider: e.target.value as AiProviderId })}
          >
            <option value="openai_compatible">OpenAI-compatible</option>
            <option value="anthropic">Anthropic</option>
          </select>
        )}
      </Field>
      <Field
        label="Provider address"
        hint={
          form.provider === 'anthropic'
            ? 'Empty means https://api.anthropic.com.'
            : 'Plain http:// only for localhost.'
        }
      >
        {(id, hintId) => (
          <input
            id={id}
            className="sv-control"
            data-testid="ai-profile-base-url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={hintId}
            value={form.baseUrl}
            onChange={(e) => edit({ baseUrl: e.target.value })}
          />
        )}
      </Field>
      {formEndpoint.ok ? (
        <p className="sv-muted sv-small" data-testid="ai-profile-endpoint-status">
          Text can be sent to {formEndpoint.origin} only.
        </p>
      ) : form.baseUrl.trim() !== '' || form.provider === 'openai_compatible' ? (
        <p className="sv-muted sv-small" data-testid="ai-profile-endpoint-status">
          {formEndpoint.reason}
        </p>
      ) : null}
      <Field label="Model id">
        {(id) => (
          <input
            id={id}
            className="sv-control ai-narrow"
            data-testid="ai-profile-model"
            autoComplete="off"
            spellCheck={false}
            value={form.model}
            onChange={(e) => edit({ model: e.target.value })}
          />
        )}
      </Field>
      <div className="sv-row sv-wrap">
        <Field label="Input $ / M tokens">
          {(id) => (
            <input
              id={id}
              className="sv-control ai-number"
              inputMode="decimal"
              value={form.priceIn}
              onChange={(e) => edit({ priceIn: e.target.value })}
            />
          )}
        </Field>
        <Field label="Output $ / M tokens">
          {(id) => (
            <input
              id={id}
              className="sv-control ai-number"
              inputMode="decimal"
              value={form.priceOut}
              onChange={(e) => edit({ priceOut: e.target.value })}
            />
          )}
        </Field>
      </div>
      <label className="sv-check">
        <input
          type="checkbox"
          data-testid="ai-profile-fallback"
          checked={form.fallback}
          onChange={(e) => edit({ fallback: e.target.checked })}
        />
        <span>
          Use this provider when an earlier one is not answering (network error, server error or
          timeout). Turn it off to use it only for the tasks you route to it below.
        </span>
      </label>
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
                Ask for JSON mode (turn off if this server rejects <code>response_format</code>)
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
        <InlineNotice tone="error" title="The provider was not saved">
          {save.error}
        </InlineNotice>
      ) : null}
      <div className="sv-row sv-wrap">
        <Button
          variant="primary"
          data-testid="ai-profile-save"
          busy={save.busy}
          {...(!dirty ? { disabledReason: 'There are no changes to save.' } : {})}
          onClick={() => void save.run()}
        >
          Save provider
        </Button>
      </div>

      <h5>API key of this provider</h5>
      {keyState === 'present' || keyState === 'other_origin' ? (
        <p data-testid="ai-profile-key-status">
          Saved key: <code data-testid="ai-profile-key-mask">{live?.key.mask}</code>
          {keyState === 'other_origin'
            ? ` (saved for ${live?.key.origin}; it is not used for the current address, enter it again)`
            : ''}
        </p>
      ) : (
        <p className="sv-muted" data-testid="ai-profile-key-status">
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
              data-testid="ai-profile-key-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
            />
          )}
        </Field>
        <Button
          data-testid="ai-profile-key-save"
          busy={saveKey.busy}
          {...(!origin
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
          data-testid="ai-profile-key-remove"
          busy={removeKey.busy}
          {...(!live?.key.mask ? { disabledReason: 'There is no saved key to remove.' } : {})}
          onClick={() => void removeKey.run()}
        >
          Remove key
        </Button>
      </div>
      {saveKey.error || removeKey.error ? (
        <InlineNotice tone="error" title="The key was not changed">
          {saveKey.error ?? removeKey.error}
        </InlineNotice>
      ) : null}

      <div className="sv-row sv-wrap">
        <Button
          data-testid="ai-profile-test"
          busy={testing}
          {...(blocker ? { disabledReason: blocker } : {})}
          onClick={runTest}
        >
          Test connection
        </Button>
        <Button
          data-testid="ai-profile-up"
          busy={move.busy}
          {...(index === 0
            ? { disabledReason: 'This provider is already the first fallback.' }
            : {})}
          onClick={() => void move.run(-1)}
        >
          Move up
        </Button>
        <Button
          data-testid="ai-profile-down"
          busy={move.busy}
          {...(index === count - 1
            ? { disabledReason: 'This provider is already the last fallback.' }
            : {})}
          onClick={() => void move.run(1)}
        >
          Move down
        </Button>
        <Button
          variant="danger"
          data-testid="ai-profile-remove"
          busy={remove.busy}
          onClick={() => setAsking(true)}
        >
          Remove provider
        </Button>
      </div>
      <p className="sv-muted sv-small">
        Test connection sends one fixed message (&quot;Reply with the single word: OK&quot;) to{' '}
        {origin ?? 'this provider'} only. No study content is sent, and it is counted in the ledger.
      </p>
      {testing ? (
        <p role="status" data-testid="ai-profile-test-progress">
          Contacting {origin ?? 'the provider'}…
        </p>
      ) : null}
      {test?.ok ? (
        <InlineNotice tone="success" live title="The provider answered">
          <span data-testid="ai-profile-test-result">
            Reply: &quot;{test.reply}&quot; in {test.latencyMs} ms, {test.tokens} tokens.
          </span>
        </InlineNotice>
      ) : null}
      {test && !test.ok ? (
        <div data-testid="ai-profile-test-result">
          <InlineNotice tone="error" title={test.view.title}>
            <p>{test.view.message}</p>
            {test.view.hint ? <p>{test.view.hint}</p> : null}
          </InlineNotice>
        </div>
      ) : null}
      {move.error || remove.error ? (
        <InlineNotice tone="error" title="That did not work">
          {move.error ?? remove.error}
        </InlineNotice>
      ) : null}
      {asking ? (
        <ConfirmDialog
          title={`Remove ${profile.label}?`}
          confirmLabel="Remove provider"
          danger
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            void remove.run();
          }}
        >
          <p>
            The provider and its saved API key are removed from this device. Tasks routed to it go
            back to starting with the primary provider.
          </p>
        </ConfirmDialog>
      ) : null}
    </li>
  );
}

/**
 * Fallback providers and per-task routing. Text only ever goes to the providers the confirmation
 * names before each request; a fallback is tried only after a network error, a server error or a
 * timeout, never after a rejected key, no quota, a rate limit, a refusal or a bad answer.
 */
export function AiRoutingSection() {
  const uid = useId();
  const env = useAiEnv();
  const epoch = useDataEpoch();
  const flag = useAiFlag();
  const cfg = useAiConfig(flag.on);
  const saved = useAsync(() => getAiSettings(), [], [epoch]);
  const add = useAction(async () => {
    await updateAiSettings((cur) => {
      if (cur.fallbacks.length >= AI_MAX_FALLBACKS) return cur;
      return {
        ...cur,
        fallbacks: [
          ...cur.fallbacks,
          {
            id: newAiProfileId(),
            label: `Fallback ${cur.fallbacks.length + 1}`,
            provider: 'openai_compatible',
            baseUrl: '',
            model: '',
            jsonMode: true,
            maxTokensParam: 'max_tokens',
            vendor: 'custom',
            reasoningEffort: '',
            authScheme: 'bearer',
            pricing: null,
            fallback: true,
          },
        ],
      };
    });
  });
  const route = useAction(async (kind: string, id: string) => {
    await updateAiSettings((cur) => {
      const routes = { ...cur.routes };
      if (id === PRIMARY_PROFILE_ID) delete routes[kind];
      else routes[kind] = id;
      return { ...cur, routes };
    });
  });

  if (!saved.data) {
    return saved.error ? (
      <InlineNotice tone="error" title="Could not read the AI settings">
        {saved.error}
      </InlineNotice>
    ) : (
      <p className="sd-line">Reading the provider list…</p>
    );
  }
  const { fallbacks, routes } = saved.data;
  const full = fallbacks.length >= AI_MAX_FALLBACKS;

  return (
    <section className="ai-block" aria-labelledby={`${uid}-h`} data-testid="ai-routing">
      <h4 className="ai-block__title" id={`${uid}-h`}>
        <Route aria-hidden="true" strokeWidth={2.4} />
        More providers
        <InfoTip label="About fallbacks" align="start">
          A fallback is tried only after a network error, a server error or no answer in time, with
          exactly the text you were shown. A rejected key, no quota, a rate limit or a refusal stops
          the request. Every confirmation lists each address that may receive it.
        </InfoTip>
      </h4>
      <p className="sd-line">
        Fall back when the primary one is not answering, or start some tasks with another model.
      </p>

      {fallbacks.length === 0 ? (
        <p className="sd-line" data-testid="ai-fallbacks-empty">
          No other providers yet.
        </p>
      ) : (
        <ol className="ai-list" aria-label="Fallback providers, in the order they are tried">
          {fallbacks.map((p, i) => (
            <ProviderCard
              key={p.id}
              profile={p}
              config={cfg.data ?? null}
              env={env}
              index={i}
              count={fallbacks.length}
              onTested={cfg.refresh}
            />
          ))}
        </ol>
      )}
      <div>
        <Button
          data-testid="ai-profile-add"
          busy={add.busy}
          {...(full
            ? { disabledReason: `You can add up to ${AI_MAX_FALLBACKS} more providers.` }
            : {})}
          onClick={() => void add.run()}
        >
          Add a fallback provider
        </Button>
      </div>
      {add.error ? (
        <InlineNotice tone="error" title="The provider was not added">
          {add.error}
        </InlineNotice>
      ) : null}

      {fallbacks.length > 0 ? (
        <fieldset className="ai-routes" data-testid="ai-routes">
          <legend className="sv-label">Which provider each task starts with</legend>
          <p className="sd-line">The others follow in the order above. Saved at once.</p>
          {AI_ACTION_KINDS.map((kind) => (
            <Field key={kind} label={AI_KIND_INFO[kind].label}>
              {(id) => (
                <select
                  id={id}
                  className="sv-control ai-narrow"
                  data-testid={`ai-route-${kind}`}
                  value={routes[kind] ?? PRIMARY_PROFILE_ID}
                  onChange={(e) => void route.run(kind, e.target.value)}
                >
                  <option value={PRIMARY_PROFILE_ID}>Primary provider (default)</option>
                  {fallbacks.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ))}
          {route.error ? (
            <InlineNotice tone="error" title="The route was not saved">
              {route.error}
            </InlineNotice>
          ) : null}
        </fieldset>
      ) : null}
    </section>
  );
}

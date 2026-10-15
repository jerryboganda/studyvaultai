import './ai.css';
import { Suspense, lazy, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  Bot,
  Cloud,
  Gauge,
  Globe,
  KeyRound,
  Laptop,
  Link,
  Monitor,
  Pencil,
  PlugZap,
  Power,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
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
import { BarMeter } from '../design/BarMeter';
import { ChunkyButton } from '../design/Buttons';
import { InfoTip } from '../design/InfoTip';
import { VaultBuddy } from '../design/VaultBuddy';
import { useAction, useAsync, useDataEpoch } from '../hooks';
import { InlineNotice } from '../Notice';
import {
  Chip,
  Choices,
  Disclosure,
  Fact,
  Facts,
  SectionHead,
  StepError,
  StepFlow,
  type FlowStep,
} from '../backup/kit';
import { useAiEnv } from './context';
import { Field } from './Field';
import { useAiConfig, useAiFlag } from './hooks';
import { describeAiError, type AiErrorView } from './labels';
import { hasEndpointAccess, requestEndpointAccess, revokeEndpointAccess } from './permission';
import { configSecrets, loadAiConfig, sendBlocker, testAiConnection } from './runtime';
import { UsageLedger } from './UsageLedger';

// Fallback providers and per-task routing: only loaded once the feature is on and this section shows.
const AiRoutingSection = lazy(() =>
  import('./AiRoutingSection').then((m) => ({ default: m.AiRoutingSection })),
);

/** The fields of the primary provider's form: everything but the fallback providers and the routes. */
type PrimarySettings = Omit<AiSettings, 'fallbacks' | 'routes'>;

type Preset = 'openai' | 'anthropic' | 'ollama' | 'lmstudio' | 'custom';

/** The provider picture cards. `custom` keeps the typed address and lets the type be chosen. */
const PRESETS: Record<
  Preset,
  { label: string; hint: string; icon: LucideIcon; provider: AiProviderId; baseUrl: string }
> = {
  openai: {
    label: 'OpenAI',
    hint: 'Cloud, API key',
    icon: Cloud,
    provider: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1',
  },
  anthropic: {
    label: 'Anthropic',
    hint: 'Cloud, API key',
    icon: Bot,
    provider: 'anthropic',
    baseUrl: '',
  },
  ollama: {
    label: 'Ollama',
    hint: 'This computer',
    icon: Laptop,
    provider: 'openai_compatible',
    baseUrl: 'http://localhost:11434/v1',
  },
  lmstudio: {
    label: 'LM Studio',
    hint: 'This computer',
    icon: Monitor,
    provider: 'openai_compatible',
    baseUrl: 'http://localhost:1234/v1',
  },
  custom: {
    label: 'Other',
    hint: 'Any address',
    icon: Link,
    provider: 'openai_compatible',
    baseUrl: '',
  },
};
const PRESET_TONE: Record<Preset, 'primary' | 'violet' | 'success' | 'neutral'> = {
  openai: 'primary',
  anthropic: 'violet',
  ollama: 'success',
  lmstudio: 'success',
  custom: 'neutral',
};

const presetOf = (provider: AiProviderId, baseUrl: string): Preset =>
  (Object.keys(PRESETS) as Preset[]).find(
    (p) =>
      p !== 'custom' &&
      PRESETS[p].provider === provider &&
      PRESETS[p].baseUrl === baseUrl.trim().replace(/\/+$/, ''),
  ) ?? 'custom';

/** Daily request limits offered as picture cards (any other stored value is offered too). */
const LIMITS = [10, 30, 100, 300] as const;

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

/** Set up enough to send: a valid address and a model id (the key is checked when sending). */
const isConfigured = (s: AiSettings) =>
  checkAiEndpoint(s.provider, s.baseUrl).ok && s.model.trim() !== '';

type TestResult =
  { ok: true; reply: string; latencyMs: number; tokens: number } | { ok: false; view: AiErrorView };

const NOT_GRANTED: AiErrorView = {
  code: 'permission_denied',
  title: 'Access to the provider was not granted',
  message: 'Chrome did not allow StudyVault to contact the provider, so nothing was sent.',
  details: [],
  retryAfterSec: null,
  hint: 'Run the test again and allow the access in Chrome’s prompt.',
};

/** What leaves the device, kept whole for whoever wants to read it (the (i) and steps stay short). */
function WhatIsSent() {
  return (
    <Disclosure summary="What is sent" icon={ShieldCheck} testId="ai-what-is-sent">
      <p>
        While AI is off, StudyVault sends nothing anywhere and every other feature works the same.
      </p>
      <p>
        When it is on and you use an AI action, StudyVault sends{' '}
        <strong>only the highlights you selected</strong> (and your question, if you ask one; in
        chat, the notes and earlier turns you tick) to the provider address you set, or to a
        fallback provider you added, which every confirmation lists. You see the exact text first,
        text that looks like an email, phone number, card number or key is replaced unless you
        choose otherwise, and nothing is sent until you press Send. Your library, notes and browsing
        history are never sent unless you select them.
      </p>
      <p>
        AI results are drafts: labelled unverified, linked to your saved quotes, and never able to
        change a saved quote or one of your notes.
      </p>
    </Disclosure>
  );
}

function TestOutcome({
  testing,
  test,
  origin,
}: {
  testing: boolean;
  test: TestResult | null;
  origin: string | null;
}) {
  return (
    <>
      {testing ? (
        <p role="status" className="sd-progress__line" data-testid="ai-test-progress">
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
  );
}

/**
 * AI settings for the options page. Off: one card that says nothing is sent, with the switch. On and
 * not set up: a setup wizard (provider picture cards, address and model, the key, a daily limit, then
 * save and test). Set up: a status card (provider, model, key, access, today's requests, Test) and an
 * "Advanced" part with the key, access, limits and pricing, fallback providers and routing, and the
 * usage ledger.
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
  const [test, setTest] = useState<TestResult | null>(null);
  const [editing, setEditing] = useState(false);
  const [step, setStep] = useState(0);
  const [preset, setPreset] = useState<Preset | null>(null);
  const [setupSaved, setSetupSaved] = useState(false);
  const [justSetUp, setJustSetUp] = useState(false);
  // A click that replaces the screen it was on moves focus to the new screen's title (WCAG 2.4.3).
  const [focusWizard, setFocusWizard] = useState(false);
  const focusStatus = useRef(false);
  const statusTitle = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusStatus.current && statusTitle.current) {
      focusStatus.current = false;
      statusTitle.current.focus();
    }
  });

  const dirty = draft !== null;
  const form = draft ?? (saved.data ? toForm(saved.data) : null);
  const edit = (patch: Partial<Form>) => {
    if (form) setDraft({ ...form, ...patch });
    setSetupSaved(false);
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

  /** The wizard's form, its address check and whether the key step applies. */
  const formEndpoint = form ? checkAiEndpoint(form.provider, form.baseUrl) : null;
  const keySaved =
    formEndpoint?.ok && config?.key.mask && config.key.origin === formEndpoint.origin
      ? config.key.mask
      : null;
  // The saved key is read after the settings: until then "no key saved" is only a guess.
  const keyPending = config || cfg.error ? undefined : 'Checking for a saved key…';

  /** Writes the wizard's answers: the settings, then the key typed for that address. */
  async function writeSetup(): Promise<boolean> {
    if (!form || !formEndpoint?.ok) return false;
    const parsed = fromForm(form);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return false;
    }
    setErrors([]);
    await updateAiSettings((current) => ({ ...current, ...parsed.settings }));
    if (keyInput.trim() !== '') {
      await setAiApiKey(keyInput, formEndpoint.origin);
      setKeyInput('');
    }
    setDraft(null);
    setSetupSaved(true);
    saved.refresh();
    cfg.refresh();
    return true;
  }

  const saveSetup = useAction(async () => {
    if (await writeSetup()) {
      focusStatus.current = true;
      setEditing(false);
      setJustSetUp(true);
      setStep(0);
    }
  });

  /** "Save and test": Chrome's prompt first (the click's gesture), then save, then one test. */
  const saveAndTest = () => {
    if (testing || !formEndpoint?.ok) return;
    const target = formEndpoint;
    // Saving makes the setup "configured": keep the wizard (and the result) open until Done.
    setEditing(true);
    setTesting(true);
    setTest(null);
    void (async () => {
      try {
        const granted = await requestEndpointAccess(target.pattern);
        setAccessRec({ pattern: target.pattern, value: granted });
        if (!(await writeSetup())) return;
        if (!granted) {
          setTest({ ok: false, view: NOT_GRANTED });
          return;
        }
        const fresh = await loadAiConfig(true, env);
        const r = await testAiConnection(fresh, env);
        setTest(
          r.ok
            ? {
                ok: true,
                reply: r.reply,
                latencyMs: r.latencyMs,
                tokens: r.inputTokens + r.outputTokens,
              }
            : { ok: false, view: describeAiError(r.error, configSecrets(fresh)) },
        );
        cfg.refresh();
      } catch (e) {
        setTest({ ok: false, view: describeAiError(e, config ? configSecrets(config) : []) });
      } finally {
        setTesting(false);
      }
    })();
  };

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
          setTest({ ok: false, view: NOT_GRANTED });
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

  if (!flag.known) return <p className="sd-line">Reading your settings…</p>;

  const headId = `${uid}-h`;
  // Pending until the setting is written: shown as chosen, busy, never snapping back; a failure
  // rolls back and is the alert notice below.
  const flagBox = (
    <AsyncSwitch
      checked={flag.on}
      testId="ai-enable"
      label="Turn on AI features"
      onChange={(next) => {
        // The switch keeps focus: the setup that appears must not take it.
        setFocusWizard(false);
        return toggle.run(next);
      }}
    />
  );
  const flagError = toggle.error ? (
    <InlineNotice tone="error" title="The setting was not saved">
      {toggle.error}
    </InlineNotice>
  ) : null;

  if (!flag.on) {
    // Same tree as the "on" branch up to the switch, so it keeps its focus and pending state.
    return (
      <section className="sd-section" aria-labelledby={headId}>
        <SectionHead
          icon={Sparkles}
          tone="violet"
          id={headId}
          title="AI assistance"
          line={
            <>
              <Chip icon={Power}>Off</Chip> Optional. Nothing is sent while it is off.
            </>
          }
        >
          {flagBox}
        </SectionHead>
        {flagError}
        <div className="sd-card ai-off">
          <div className="ai-off__row">
            <VaultBuddy pose="sleep" size={88} />
            <div className="sd-stack">
              <p className="ai-off__title">Drafts from your highlights</p>
              <p className="sd-line">Only highlights you pick, after you see them.</p>
              <div className="sd-row">
                <ChunkyButton
                  variant="primary"
                  size="lg"
                  icon={Sparkles}
                  aria-busy={toggle.busy || undefined}
                  data-testid="ai-setup-start"
                  onClick={() => {
                    if (toggle.busy) return;
                    setFocusWizard(true);
                    void toggle.run(true);
                  }}
                >
                  Set up AI
                </ChunkyButton>
              </div>
            </div>
          </div>
          <WhatIsSent />
        </div>
      </section>
    );
  }

  const configured = saved.data ? isConfigured(saved.data) : false;
  const showWizard = !!form && (!configured || editing);
  const blocker = !config
    ? 'Reading the AI settings…'
    : dirty
      ? 'Save your changes first: the test uses the saved settings.'
      : sendBlocker(config, env);
  const keyState = config?.key.state;
  const origin = endpoint?.ok ? endpoint.origin : null;
  const savedPreset = saved.data ? presetOf(saved.data.provider, saved.data.baseUrl) : 'custom';
  // Nothing is picked for a fresh setup (an empty OpenAI-compatible address); an existing one shows.
  const choice =
    preset ??
    (form && (form.baseUrl.trim() !== '' || form.provider === 'anthropic')
      ? presetOf(form.provider, form.baseUrl)
      : null);
  const needsKey = formEndpoint?.ok ? !formEndpoint.loopback : true;

  const limitValue = form ? form.maxRequests : '30';
  const limitOptions = [
    ...new Set([
      ...LIMITS.map(String),
      ...(limitValue && /^\d+$/.test(limitValue) ? [limitValue] : []),
    ]),
  ].sort((a, b) => Number(a) - Number(b));

  const steps: FlowStep[] = form
    ? [
        {
          id: 'provider',
          title: 'Pick a provider',
          validate: () => (choice ? null : 'Pick a provider.'),
          content: ({ error, errorId }) => (
            <Choices<Preset>
              name={`${uid}-preset`}
              label="Provider"
              columns={3}
              value={choice}
              invalid={!!error}
              describedBy={error ? errorId : undefined}
              testId="ai-provider-choice"
              onChange={(p) => {
                setPreset(p);
                if (p === 'custom') edit({ provider: 'openai_compatible' });
                else edit({ provider: PRESETS[p].provider, baseUrl: PRESETS[p].baseUrl });
              }}
              options={(Object.keys(PRESETS) as Preset[]).map((p) => ({
                value: p,
                label: PRESETS[p].label,
                hint: PRESETS[p].hint,
                icon: PRESETS[p].icon,
                tone: PRESET_TONE[p],
                testId: `ai-preset-${p}`,
              }))}
            />
          ),
        },
        {
          id: 'address',
          title: 'Address and model',
          inlineError: true,
          validate: () =>
            !formEndpoint?.ok
              ? (formEndpoint?.reason ?? 'Enter the provider address.')
              : form.model.trim() === ''
                ? 'Enter the model id from your provider.'
                : null,
          content: ({ error, errorId }) => (
            <>
              {choice === 'custom' ? (
                <Field label="Provider type">
                  {(id) => (
                    <select
                      id={id}
                      className="sv-control ai-narrow"
                      data-testid="ai-provider"
                      value={form.provider}
                      onChange={(e) => edit({ provider: e.target.value as AiProviderId })}
                    >
                      <option value="openai_compatible">OpenAI-compatible</option>
                      <option value="anthropic">Anthropic</option>
                    </select>
                  )}
                </Field>
              ) : null}
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
                    data-testid="ai-base-url"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="https://api.example.com/v1"
                    aria-invalid={(!!error && !formEndpoint?.ok) || undefined}
                    aria-describedby={[hintId, error && !formEndpoint?.ok ? errorId : '']
                      .filter(Boolean)
                      .join(' ')}
                    value={form.baseUrl}
                    onChange={(e) => edit({ baseUrl: e.target.value })}
                  />
                )}
              </Field>
              {error && !formEndpoint?.ok ? <StepError id={errorId}>{error}</StepError> : null}
              {/* After a failed Next the step error says it once, under the step. */}
              {formEndpoint &&
              !formEndpoint.ok &&
              !error &&
              (form.baseUrl.trim() !== '' || form.provider === 'openai_compatible') ? (
                <p className="sd-line" data-testid="ai-endpoint-status">
                  {formEndpoint.reason}
                </p>
              ) : null}
              {formEndpoint?.ok ? (
                <p className="sd-line" data-testid="ai-endpoint-status">
                  <Globe aria-hidden="true" className="ai-inline-icon" /> Requests go to{' '}
                  {formEndpoint.origin} only.
                </p>
              ) : null}
              <Field label="Model id" hint="Copy it from your provider.">
                {(id, hintId) => (
                  <input
                    id={id}
                    className="sv-control ai-narrow"
                    data-testid="ai-model"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={(!!error && !!formEndpoint?.ok) || undefined}
                    aria-describedby={[hintId, error && formEndpoint?.ok ? errorId : '']
                      .filter(Boolean)
                      .join(' ')}
                    value={form.model}
                    onChange={(e) => edit({ model: e.target.value })}
                  />
                )}
              </Field>
              {error && formEndpoint?.ok ? <StepError id={errorId}>{error}</StepError> : null}
            </>
          ),
        },
        ...(needsKey
          ? [
              {
                id: 'key',
                title: 'API key',
                inlineError: true,
                pending: keyPending,
                validate: () =>
                  keyInput.trim() === '' && !keySaved
                    ? 'Paste the API key from your provider.'
                    : null,
                content: ({ error, errorId }: { error: string | null; errorId: string }) => (
                  <>
                    <p className="sd-line">
                      <KeyRound aria-hidden="true" className="ai-inline-icon" /> Kept on this
                      device, sent only to {formEndpoint?.ok ? formEndpoint.host : 'the provider'}.{' '}
                      <InfoTip label="Where your key is kept">
                        It is stored in the extension&apos;s browser storage without extra
                        encryption. Use a key with a low spending limit. It is never written to
                        backups, exports or logs.
                      </InfoTip>
                    </p>
                    {keySaved ? (
                      <p className="sd-line" data-testid="ai-key-status">
                        Saved key: <code data-testid="ai-key-mask">{keySaved}</code>. Paste a new
                        one to replace it.
                      </p>
                    ) : keyPending ? (
                      <p className="sd-line">{keyPending}</p>
                    ) : null}
                    <Field label={keySaved ? 'New key (optional)' : 'API key'}>
                      {(id) => (
                        <input
                          id={id}
                          className="sv-control ai-narrow"
                          data-testid="ai-key-input"
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          aria-invalid={!!error || undefined}
                          aria-describedby={error ? errorId : undefined}
                          value={keyInput}
                          onChange={(e) => {
                            setKeyInput(e.target.value);
                            setSetupSaved(false);
                          }}
                        />
                      )}
                    </Field>
                    {error ? <StepError id={errorId}>{error}</StepError> : null}
                  </>
                ),
              },
            ]
          : []),
        {
          id: 'limit',
          title: 'Daily limit',
          content: (
            <>
              <Choices
                name={`${uid}-limit`}
                label="Requests per day"
                columns={4}
                value={limitValue}
                testId="ai-limit-choice"
                onChange={(v) => edit({ maxRequests: v })}
                options={limitOptions.map((v) => ({
                  value: v,
                  label: v,
                  hint: 'requests a day',
                  icon: Gauge,
                  tone: Number(v) <= 30 ? 'success' : 'sun',
                  testId: `ai-limit-${v}`,
                }))}
              />
              <p className="sd-line">
                Only what you select is sent, after you see it and press Send.
              </p>
              <WhatIsSent />
            </>
          ),
        },
        {
          id: 'test',
          title: 'Save and test',
          content: (
            <>
              <Facts testId="ai-setup-summary">
                <Fact icon={PRESETS[choice ?? 'custom'].icon} label="Provider">
                  {PRESETS[choice ?? 'custom'].label}
                </Fact>
                <Fact icon={Globe} label="Address">
                  {formEndpoint?.ok ? formEndpoint.origin : '—'}
                </Fact>
                <Fact icon={Sparkles} label="Model">
                  {form.model.trim()}
                </Fact>
                <Fact icon={KeyRound} label="Key">
                  {!needsKey
                    ? 'Not needed'
                    : keyInput.trim() !== ''
                      ? 'New key, saved on Save'
                      : (keySaved ?? 'None')}
                </Fact>
                <Fact icon={Gauge} label="Daily limit">
                  {form.maxRequests} requests
                </Fact>
              </Facts>
              <div className="sd-row">
                <ChunkyButton
                  variant="primary"
                  icon={PlugZap}
                  aria-busy={testing || undefined}
                  data-testid="ai-save-test"
                  onClick={saveAndTest}
                >
                  Save and test
                </ChunkyButton>
                <InfoTip label="About the test">
                  It sends one fixed message (&quot;Reply with the single word: OK&quot;). No study
                  content is sent, and it counts as one request today.
                </InfoTip>
              </div>
              <TestOutcome
                testing={testing}
                test={test}
                origin={formEndpoint?.ok ? formEndpoint.origin : null}
              />
            </>
          ),
        },
      ]
    : [];

  return (
    <section className="sd-section" aria-labelledby={headId}>
      <SectionHead
        icon={Sparkles}
        tone="violet"
        id={headId}
        title="AI assistance"
        line={
          !configured ? (
            <Chip icon={Power} tone="warning">
              Set up needed
            </Chip>
          ) : editing ? (
            <Chip icon={Pencil}>Editing</Chip>
          ) : (
            <Chip icon={Power} tone="success">
              On
            </Chip>
          )
        }
      >
        {flagBox}
      </SectionHead>
      {flagError}

      {saved.error ? (
        <InlineNotice tone="error" title="Could not read the AI settings">
          {saved.error}
        </InlineNotice>
      ) : null}
      {!form && !saved.error ? <p className="sd-line">Reading the AI settings…</p> : null}

      {showWizard ? (
        <>
          <StepFlow
            label={configured ? 'Edit AI setup' : 'AI setup'}
            steps={steps}
            index={step}
            onIndex={setStep}
            testId="ai-setup"
            autoFocus={focusWizard}
            finish={{
              label: setupSaved && !dirty && keyInput.trim() === '' ? 'Done' : 'Save',
              icon: Save,
              testId: 'ai-setup-save',
              busy: saveSetup.busy,
              onClick: () => {
                if (setupSaved && !dirty && keyInput.trim() === '') {
                  focusStatus.current = true;
                  setEditing(false);
                  setJustSetUp(true);
                  setStep(0);
                } else void saveSetup.run();
              },
            }}
          />
          {errors.length > 0 ? (
            <InlineNotice tone="error" title="Check these settings">
              <ul>
                {errors.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </InlineNotice>
          ) : null}
          {saveSetup.error ? (
            <InlineNotice tone="error" title="The settings were not saved">
              {saveSetup.error}
            </InlineNotice>
          ) : null}
          {configured ? (
            <div className="sd-row">
              <ChunkyButton
                variant="ghost"
                data-testid="ai-setup-cancel"
                onClick={() => {
                  focusStatus.current = true;
                  setEditing(false);
                  setDraft(null);
                  setKeyInput('');
                  setPreset(null);
                  setStep(0);
                  setErrors([]);
                }}
              >
                Cancel editing
              </ChunkyButton>
            </div>
          ) : null}
        </>
      ) : null}

      {form && configured && !editing ? (
        <>
          <div className="sd-card" data-testid="ai-status">
            {justSetUp ? (
              <InlineNotice tone="success" live title="AI is set up">
                Results are drafts marked “unverified” until you check them against your quotes.
              </InlineNotice>
            ) : null}
            <div className="sd-row">
              <span className={`sd-tile sv-art--${PRESET_TONE[savedPreset]}`} aria-hidden="true">
                {(() => {
                  const Icon = PRESETS[savedPreset].icon;
                  return <Icon strokeWidth={2.4} />;
                })()}
              </span>
              <div className="sd-head__text">
                <h3 className="sd-card__title ai-status__title" ref={statusTitle} tabIndex={-1}>
                  {savedPreset === 'custom'
                    ? endpoint?.ok
                      ? endpoint.host
                      : 'Your provider'
                    : PRESETS[savedPreset].label}
                </h3>
                <p className="sd-line" data-testid="ai-endpoint-status">
                  {origin ? `Requests go to ${origin} only.` : 'The address is not valid.'}
                </p>
              </div>
            </div>
            <div className="sd-row">
              <Chip icon={Sparkles}>{saved.data?.model}</Chip>
              <StatusKey
                state={keyState}
                mask={config?.key.mask ?? null}
                otherOrigin={config?.key.origin ?? null}
              />
              <Chip
                icon={ShieldCheck}
                tone={access === null ? 'neutral' : access ? 'success' : 'warning'}
              >
                Access:{' '}
                <span data-testid="ai-access-status">
                  {access === null ? 'checking' : access ? 'allowed' : 'not allowed yet'}
                </span>
              </Chip>
            </div>
            {config ? (
              <div className="ai-usage">
                <span className="sd-line">Today</span>
                <BarMeter
                  value={config.budget.requests}
                  max={config.settings.limits.maxRequestsPerDay}
                  label="AI requests today"
                  valueText={`${config.budget.requests} of ${config.settings.limits.maxRequestsPerDay} requests`}
                  tone={
                    config.budget.requests >= config.settings.limits.maxRequestsPerDay
                      ? 'sun'
                      : 'violet'
                  }
                />
                <span className="ai-usage__num">
                  {config.budget.requests}/{config.settings.limits.maxRequestsPerDay}
                </span>
              </div>
            ) : null}
            <div className="sd-row">
              {/* Button, not ChunkyButton: its reason comes and goes and the element must stay. */}
              <Button
                variant="primary"
                data-testid="ai-test"
                busy={testing}
                {...(blocker ? { disabledReason: blocker } : {})}
                onClick={runTest}
              >
                <PlugZap aria-hidden="true" className="ai-inline-icon" /> Test connection
              </Button>
              {access === false && pattern ? (
                <Button
                  data-testid="ai-access-allow"
                  busy={allow.busy}
                  onClick={() => void allow.run()}
                >
                  Allow access
                </Button>
              ) : null}
              <ChunkyButton
                variant="ghost"
                icon={Pencil}
                data-testid="ai-edit-setup"
                onClick={() => {
                  setFocusWizard(true);
                  setDraft(saved.data ? toForm(saved.data) : null);
                  setPreset(null);
                  setTest(null);
                  setJustSetUp(false);
                  setSetupSaved(false);
                  setStep(0);
                  setEditing(true);
                }}
              >
                Edit setup
              </ChunkyButton>
              <InfoTip label="About the test">
                It sends one fixed message (&quot;Reply with the single word: OK&quot;) to{' '}
                {origin ?? 'the provider'}. No study content is sent; it counts in the ledger.
              </InfoTip>
            </div>
            {blocker ? <p className="sd-line">{blocker}</p> : null}
            <TestOutcome testing={testing} test={test} origin={origin} />
            {allow.error || revoke.error ? (
              <InlineNotice tone="error" title="Chrome did not change the access">
                {allow.error ?? revoke.error}
              </InlineNotice>
            ) : null}
          </div>

          <Disclosure summary="Advanced" icon={SlidersHorizontal} testId="ai-advanced">
            <AdvancedBlock title="API key" icon={KeyRound}>
              <div className="sd-row ai-keyrow">
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
                    ? {
                        disabledReason:
                          'Save a valid provider address first: the key is tied to it.',
                      }
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
              <p className="sd-line">
                Stored on this device <strong>without extra encryption</strong>; never in backups,
                exports or logs.
              </p>
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
            </AdvancedBlock>

            <AdvancedBlock title="Access" icon={ShieldCheck}>
              <p className="sd-line">
                Chrome must let StudyVault contact {origin ?? 'the provider'}
                {origin?.startsWith('http://') ? ' (every port on this host)' : ''}. It asks when
                you press Allow, Send or Test.
              </p>
              <div className="sd-row">
                <Button
                  data-testid="ai-access-revoke"
                  busy={revoke.busy}
                  {...(!access ? { disabledReason: 'Access has not been allowed.' } : {})}
                  onClick={() => void revoke.run()}
                >
                  Remove access
                </Button>
              </div>
            </AdvancedBlock>

            <AdvancedBlock title="Limits and pricing" icon={Gauge}>
              <div className="ai-grid">
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
                <Field label="Cost per day ($)">
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
                <Field label="Input $ / M tokens">
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
                <Field label="Output $ / M tokens">
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
                <Field label="Answer choices">
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
              <p className="sd-line">
                Prices come from your provider; without them cost reads “unknown” and a cost limit
                cannot be used.
              </p>
              {form.provider === 'openai_compatible' ? (
                <Disclosure summary="Compatibility" icon={Wrench}>
                  <label className="sv-check">
                    <input
                      type="checkbox"
                      checked={form.jsonMode}
                      onChange={(e) => edit({ jsonMode: e.target.checked })}
                    />
                    <span>
                      Ask for JSON mode (turn off if your server rejects{' '}
                      <code>response_format</code>)
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
                </Disclosure>
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
              <div className="sd-row">
                <Button
                  variant="primary"
                  data-testid="ai-save-settings"
                  busy={save.busy}
                  {...(!dirty ? { disabledReason: 'There are no changes to save.' } : {})}
                  onClick={() => void save.run()}
                >
                  Save settings
                </Button>
              </div>
            </AdvancedBlock>

            <Suspense fallback={<p className="sd-line">Loading the provider list…</p>}>
              <AiRoutingSection />
            </Suspense>

            <UsageLedger />
          </Disclosure>
        </>
      ) : null}
    </section>
  );
}

function StatusKey({
  state,
  mask,
  otherOrigin,
}: {
  state: string | undefined;
  mask: string | null;
  otherOrigin: string | null;
}) {
  if (state === 'present' || state === 'other_origin') {
    return (
      <Chip icon={KeyRound} tone={state === 'present' ? 'success' : 'warning'}>
        <span data-testid="ai-key-status">
          Key <code data-testid="ai-key-mask">{mask}</code>
          {state === 'other_origin' ? ` (saved for ${otherOrigin}; enter it again)` : ''}
        </span>
      </Chip>
    );
  }
  return (
    <Chip icon={KeyRound} tone={state === 'not_needed' ? 'neutral' : 'warning'}>
      <span data-testid="ai-key-status">
        {state === 'not_needed' ? 'No key needed' : 'No key saved'}
      </span>
    </Chip>
  );
}

function AdvancedBlock({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <div className="ai-block">
      <h4 className="ai-block__title">
        <Icon aria-hidden="true" strokeWidth={2.4} />
        {title}
      </h4>
      {children}
    </div>
  );
}

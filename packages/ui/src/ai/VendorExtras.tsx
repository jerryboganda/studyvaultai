// Vendor-specific parts of the AI settings: the model + reasoning-effort pickers, the ChatGPT
// (Codex) sign-in, and the live usage panel. Nothing here runs until a button is pressed.
import { useId, useRef, useState } from 'react';
import { LogIn, LogOut } from 'lucide-react';
import { browser } from 'wxt/browser';
import {
  buildCodexAuthorizeUrl,
  codexAuthOrigins,
  codexCallbackParams,
  exchangeCodexCode,
  fetchCodexUsage,
  isAiError,
  newCodexPkce,
  refreshCodexTokens,
  type CodexUsage,
} from '@ai';
import {
  clearCodexAuth,
  getAiApiKey,
  getCodexAuth,
  setCodexAuth,
  type AiAuthScheme,
  type AiEffort,
  type AiEndpointCheck,
  type AiVendorId,
} from '@storage';
import { Button } from '../Button';
import { BarMeter } from '../design/BarMeter';
import { InlineNotice } from '../Notice';
import { useAiEnv } from './context';
import { Field } from './Field';
import { requestEndpointAccess } from './permission';
import {
  VENDORS,
  effortsFor,
  fetchModelList,
  isUbagThinkingId,
  ubagThinkingOptions,
  type ModelEntry,
} from './vendors';

const EFFORT_LABEL: Record<AiEffort, string> = {
  '': 'Model default',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Maximum',
};

const message = (e: unknown): string =>
  isAiError(e) ? e.message : e instanceof Error ? e.message : 'Something went wrong.';

/**
 * Model dropdown (live list with a curated fallback; any id can still be typed) and the reasoning
 * effort dropdown for the chosen model. The effort control is disabled, with the reason, when the
 * vendor or model has none.
 */
export function ModelPicker(props: {
  vendor: AiVendorId;
  model: string;
  effort: AiEffort;
  authScheme: AiAuthScheme;
  endpoint: AiEndpointCheck | null;
  /** Credentials are required to list models (cloud vendors). */
  needsKey: boolean;
  keyInput: string;
  onKeyInput(v: string): void;
  /** Mask of a key already saved for this address, or null. */
  keySaved: string | null;
  onModel(m: string): void;
  onEffort(e: AiEffort): void;
  invalid?: boolean;
  describedBy?: string;
}) {
  const env = useAiEnv();
  const uid = useId();
  const spec = VENDORS[props.vendor];
  const [loaded, setLoaded] = useState<{
    key: string;
    models: ModelEntry[] | null;
    note: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const origin = props.endpoint?.ok ? props.endpoint.origin : '';
  // A list belongs to one address and vendor; switching either drops it.
  const listKey = `${props.vendor}|${origin}`;
  const models = loaded?.key === listKey ? loaded.models : null;
  const note = loaded?.key === listKey ? loaded.note : null;
  const setNote = (n: string | null) => setLoaded({ key: listKey, models, note: n });

  const canList = spec.liveModels && props.endpoint?.ok === true;
  const needsCreds = props.needsKey && props.keyInput.trim() === '' && !props.keySaved;

  const load = async () => {
    const endpoint = props.endpoint;
    if (!endpoint?.ok || loading) return;
    setLoading(true);
    setNote(null);
    try {
      // First await of the click: the permission prompt needs the user gesture.
      const granted = await requestEndpointAccess(endpoint.pattern);
      if (!granted) {
        setNote('Chrome did not allow access to the provider, so the list was not loaded.');
        return;
      }
      const key = props.keyInput.trim() || (await getAiApiKey(endpoint.origin));
      const list = await fetchModelList({
        baseUrl: endpoint.url,
        apiKey: key,
        authScheme: props.authScheme,
        fetch: (u, i) => env.fetch(u, i),
      });
      if (list) {
        setLoaded({
          key: listKey,
          models: list,
          note: `${list.length} models loaded from ${endpoint.host}.`,
        });
      } else {
        setNote(
          'Could not load the list (check the address and key). You can still type a model id.',
        );
      }
    } finally {
      setLoading(false);
    }
  };

  const ids = (models ?? spec.curatedModels.map((id) => ({ id }))).map((m) => m.id);
  const options = props.vendor === 'ubag' ? ids.filter((id) => !isUbagThinkingId(id)) : ids;
  const listId = `${uid}-models`;

  // UBAG: a thinking level is its own model id, so the effort control swaps the model id.
  const ubagLevels = props.vendor === 'ubag' ? ubagThinkingOptions(models ?? [], props.model) : [];
  const efforts =
    props.vendor === 'ubag' ? [] : effortsFor(props.vendor, props.model, models ?? []);
  const effortDisabled = props.vendor === 'ubag' ? ubagLevels.length === 0 : efforts.length === 0;
  const effortReason =
    props.vendor === 'ubag'
      ? models
        ? 'This target has no selectable thinking levels.'
        : 'Load the model list to see the thinking levels.'
      : spec.noEffortReason;

  return (
    <>
      {spec.liveModels && props.needsKey && !props.keySaved && props.vendor !== 'chatgpt_codex' ? (
        <Field
          label={spec.keyLabel}
          hint={`${spec.keyHelp} Only used to list models and sent to ${origin || 'the provider'}.`}
        >
          {(id, hintId) => (
            <input
              id={id}
              className="sv-control ai-narrow"
              data-testid="ai-model-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-describedby={hintId}
              value={props.keyInput}
              onChange={(e) => props.onKeyInput(e.target.value)}
            />
          )}
        </Field>
      ) : null}
      <Field label="Model" hint={models ? undefined : 'Pick one, or type any model id.'}>
        {(id, hintId) => (
          <>
            <input
              id={id}
              className="sv-control ai-narrow"
              data-testid="ai-model"
              list={listId}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={props.invalid || undefined}
              aria-describedby={[hintId, props.describedBy ?? ''].filter(Boolean).join(' ')}
              value={props.model}
              onChange={(e) => props.onModel(e.target.value)}
            />
            <datalist id={listId}>
              {options.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </>
        )}
      </Field>
      {spec.liveModels ? (
        <div className="sd-row">
          <Button
            data-testid="ai-load-models"
            busy={loading}
            {...(!canList
              ? { disabledReason: 'Enter a valid provider address first.' }
              : needsCreds
                ? { disabledReason: 'Enter the credentials above to list models.' }
                : {})}
            onClick={() => void load()}
          >
            Load model list
          </Button>
          {note ? (
            <span className="sd-line" role="status" data-testid="ai-models-note">
              {note}
            </span>
          ) : null}
        </div>
      ) : null}
      <Field
        label={props.vendor === 'ubag' ? 'Thinking level' : 'Reasoning effort'}
        hint={effortDisabled ? effortReason : undefined}
      >
        {(id, hintId) =>
          props.vendor === 'ubag' ? (
            <select
              id={id}
              className="sv-control ai-narrow"
              data-testid="ai-effort"
              disabled={effortDisabled}
              aria-describedby={effortDisabled ? hintId : undefined}
              value={isUbagThinkingId(props.model) ? props.model : ''}
              onChange={(e) =>
                props.onModel(
                  e.target.value === '' ? (props.model.split('|')[0] ?? '') : e.target.value,
                )
              }
            >
              <option value="">Operator default</option>
              {ubagLevels.map((l) => (
                <option key={l} value={l}>
                  {l.slice(l.indexOf('|') + 1)}
                </option>
              ))}
            </select>
          ) : (
            <select
              id={id}
              className="sv-control ai-narrow"
              data-testid="ai-effort"
              disabled={effortDisabled}
              aria-describedby={effortDisabled ? hintId : undefined}
              value={effortDisabled ? '' : props.effort}
              onChange={(e) => props.onEffort(e.target.value as AiEffort)}
            >
              <option value="">{EFFORT_LABEL['']}</option>
              {efforts.map((v) => (
                <option key={v} value={v}>
                  {EFFORT_LABEL[v]}
                </option>
              ))}
            </select>
          )
        }
      </Field>
    </>
  );
}

const resetText = (secs: number | null): string => {
  if (secs === null) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return ` · resets in ${h > 0 ? `${h} h ` : ''}${m} min`;
};

const windowName = (minutes: number | null): string =>
  minutes === null
    ? 'Usage window'
    : minutes >= 10_000
      ? 'Weekly limit'
      : minutes >= 60
        ? `${Math.round(minutes / 60)}-hour limit`
        : `${minutes}-minute limit`;

/** ChatGPT sign-in/out and the subscription quota. `onChanged` re-reads the AI configuration. */
export function CodexSignIn({ signedIn, onChanged }: { signedIn: boolean; onChanged(): void }) {
  const env = useAiEnv();
  const pkce = useRef<{ verifier: string; state: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paste, setPaste] = useState('');
  const [waiting, setWaiting] = useState(false);

  const finish = async (code: string, state: string) => {
    const p = pkce.current;
    if (!p || p.state !== state) {
      throw new Error('That sign-in answer does not belong to this attempt. Start again.');
    }
    const tokens = await exchangeCodexCode((u, i) => env.fetch(u, i), code, p.verifier, Date.now());
    await setCodexAuth(tokens);
    pkce.current = null;
    setWaiting(false);
    setPaste('');
    onChanged();
  };

  const start = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      // First await of the click (user gesture). localhost lets the tab's address be seen.
      const granted = await requestEndpointAccess([...codexAuthOrigins(), 'http://localhost/*']);
      if (!granted) throw new Error('Chrome did not allow access to the sign-in addresses.');
      const p = await newCodexPkce();
      pkce.current = { verifier: p.verifier, state: p.state };
      const tab = await browser.tabs.create({ url: buildCodexAuthorizeUrl(p.challenge, p.state) });
      setWaiting(true);
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          browser.tabs.onUpdated.removeListener(onUpdated);
          browser.tabs.onRemoved.removeListener(onRemoved);
        };
        const timer = setTimeout(() => {
          done();
          reject(new Error('Sign-in timed out. Start again, or paste the address you ended on.'));
        }, 600_000);
        const onUpdated = (tabId: number, info: { url?: string }, t: { url?: string }) => {
          const url = info.url ?? t.url;
          if (tabId !== tab.id || !url) return;
          const r = codexCallbackParams(url);
          if (!r) return;
          done();
          void browser.tabs.remove(tabId).catch(() => undefined);
          if ('error' in r) reject(new Error(`ChatGPT refused the sign-in (${r.error}).`));
          else finish(r.code, r.state).then(resolve, reject);
        };
        const onRemoved = (tabId: number) => {
          if (tabId !== tab.id) return;
          done();
          reject(new Error('The sign-in tab was closed before finishing.'));
        };
        browser.tabs.onUpdated.addListener(onUpdated);
        browser.tabs.onRemoved.addListener(onRemoved);
      });
    } catch (e) {
      setError(message(e));
    } finally {
      setWaiting(false);
      setBusy(false);
    }
  };

  const finishPasted = async () => {
    const r = codexCallbackParams(paste);
    if (!r) {
      setError(
        'That is not the sign-in address (it starts with http://localhost:1455/auth/callback).',
      );
      return;
    }
    if ('error' in r) {
      setError(`ChatGPT refused the sign-in (${r.error}).`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await finish(r.code, r.state);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    await clearCodexAuth();
    onChanged();
  };

  return (
    <div className="sd-stack" data-testid="ai-codex">
      <p className="sd-line">
        Uses your ChatGPT subscription through the same sign-in the Codex app uses. This is{' '}
        <strong>unofficial</strong> and may stop working without notice. Tokens stay on this device.
      </p>
      <p className="sd-line" data-testid="ai-codex-status">
        {signedIn ? 'Signed in to ChatGPT.' : 'Not signed in.'}
      </p>
      <div className="sd-row">
        <Button
          variant="primary"
          data-testid="ai-codex-signin"
          busy={busy}
          onClick={() => void start()}
        >
          <LogIn aria-hidden="true" className="ai-inline-icon" />{' '}
          {signedIn ? 'Sign in again' : 'Sign in with ChatGPT'}
        </Button>
        {signedIn ? (
          <Button data-testid="ai-codex-signout" onClick={() => void signOut()}>
            <LogOut aria-hidden="true" className="ai-inline-icon" /> Sign out
          </Button>
        ) : null}
      </div>
      {waiting || paste ? (
        <Field
          label="Or paste the address you ended on"
          hint="If the tab shows an error page, copy its address here."
        >
          {(id, hintId) => (
            <div className="sd-row">
              <input
                id={id}
                className="sv-control"
                data-testid="ai-codex-paste"
                aria-describedby={hintId}
                autoComplete="off"
                spellCheck={false}
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
              />
              <Button data-testid="ai-codex-finish" onClick={() => void finishPasted()}>
                Finish sign-in
              </Button>
            </div>
          )}
        </Field>
      ) : null}
      {error ? (
        <InlineNotice tone="error" title="Sign-in problem">
          {error}
        </InlineNotice>
      ) : null}
    </div>
  );
}

type UsageView =
  | { kind: 'codex'; usage: CodexUsage }
  | { kind: 'openrouter'; used: number; limit: number | null; remaining: number | null };

/** Real usage for vendors that report it: the ChatGPT quota windows and OpenRouter spend. */
export function VendorUsage({
  vendor,
  baseUrl,
  origin,
}: {
  vendor: AiVendorId;
  baseUrl: string;
  origin: string | null;
}) {
  const env = useAiEnv();
  const [view, setView] = useState<UsageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (vendor !== 'chatgpt_codex' && vendor !== 'openrouter') return null;

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      if (vendor === 'chatgpt_codex') {
        let auth = await getCodexAuth();
        if (!auth) throw new Error('Sign in with ChatGPT first.');
        if (auth.expiresAt - Date.now() < 60_000) {
          auth = await refreshCodexTokens((u, i) => env.fetch(u, i), auth, Date.now());
          await setCodexAuth(auth);
        }
        setView({
          kind: 'codex',
          usage: await fetchCodexUsage((u, i) => env.fetch(u, i), auth),
        });
      } else {
        const key = origin ? await getAiApiKey(origin) : null;
        if (!key) throw new Error('Save the OpenRouter key first.');
        const res = await env.fetch(`${baseUrl.replace(/\/+$/, '')}/key`, {
          headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(`OpenRouter answered HTTP ${res.status}.`);
        const d = ((await res.json()) as { data?: Record<string, unknown> }).data ?? {};
        const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
        setView({
          kind: 'openrouter',
          used: n(d.usage) ?? 0,
          limit: n(d.limit),
          remaining: n(d.limit_remaining),
        });
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sd-stack" data-testid="ai-vendor-usage">
      <div className="sd-row">
        <Button data-testid="ai-usage-check" busy={busy} onClick={() => void check()}>
          Check {vendor === 'chatgpt_codex' ? 'ChatGPT quota' : 'OpenRouter usage'}
        </Button>
      </div>
      {error ? <p className="sd-line">{error}</p> : null}
      {view?.kind === 'codex' ? (
        view.usage.windows.length > 0 ? (
          <>
            {view.usage.plan ? <p className="sd-line">Plan: {view.usage.plan}</p> : null}
            {view.usage.windows.map((w, i) => (
              <div key={i} className="ai-usage">
                <span className="sd-line">{windowName(w.windowMinutes)}</span>
                <BarMeter
                  value={Math.round(w.usedPercent)}
                  max={100}
                  label={windowName(w.windowMinutes)}
                  valueText={`${Math.round(w.usedPercent)}% used${resetText(w.resetsInSeconds)}`}
                  tone={w.usedPercent >= 90 ? 'sun' : 'violet'}
                />
                <span className="ai-usage__num">{Math.round(w.usedPercent)}%</span>
              </div>
            ))}
          </>
        ) : (
          <p className="sd-line">ChatGPT did not report quota windows for this account.</p>
        )
      ) : null}
      {view?.kind === 'openrouter' ? (
        <p className="sd-line" data-testid="ai-openrouter-usage">
          Used ${view.used.toFixed(4)}
          {view.limit !== null ? ` of $${view.limit.toFixed(2)}` : ' (no spending limit set)'}
          {view.remaining !== null ? ` · $${view.remaining.toFixed(2)} left` : ''}.
        </p>
      ) : null}
    </div>
  );
}

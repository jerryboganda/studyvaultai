// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  VENDORS,
  effortsFor,
  fetchModelList,
  isUbagThinkingId,
  providerNeedsKey,
  ubagThinkingOptions,
  vendorOf,
} from './vendors';

const listFetch =
  (body: unknown, status = 200) =>
  async () =>
    new Response(JSON.stringify(body), { status });

describe('vendor presets', () => {
  it('recognises a preset by its recorded vendor or its address', () => {
    expect(vendorOf('ubag', 'openai_compatible', '')).toBe('ubag');
    expect(vendorOf('custom', 'openai_compatible', 'https://openrouter.ai/api/v1/')).toBe(
      'openrouter',
    );
    expect(vendorOf('custom', 'openai_compatible', 'https://x.test/v1')).toBe('custom');
  });

  it('needs credentials off this computer, and always for Anthropic and ChatGPT', () => {
    expect(providerNeedsKey('openai_compatible', true)).toBe(false);
    expect(providerNeedsKey('openai_compatible', false)).toBe(true);
    expect(providerNeedsKey('anthropic', true)).toBe(true);
    expect(providerNeedsKey('codex_responses', true)).toBe(true);
  });

  it('offers efforts only where the model takes them', () => {
    expect(effortsFor('openai', 'gpt-4o-mini')).toEqual([]);
    expect(effortsFor('openai', 'gpt-5')).toContain('high');
    expect(effortsFor('anthropic', 'claude-sonnet-5-5')).toEqual([]);
    expect(effortsFor('openrouter', 'a/b', [{ id: 'a/b', reasoning: false }])).toEqual([]);
    expect(effortsFor('openrouter', 'a/b', [{ id: 'a/b', reasoning: true }])).toContain('low');
    expect(VENDORS.ubag.reasoningStyle).toBe('none');
  });

  it('treats UBAG thinking levels as their own model ids', () => {
    expect(isUbagThinkingId('chatgpt_web|Medium')).toBe(true);
    expect(isUbagThinkingId('chatgpt_web|GPT-5.6 Sol')).toBe(false);
    expect(isUbagThinkingId('chatgpt_web')).toBe(false);
    const models = ['chatgpt_web', 'chatgpt_web|GPT-5.6 Sol', 'chatgpt_web|Medium', 'x|High'].map(
      (id) => ({ id }),
    );
    expect(ubagThinkingOptions(models, 'chatgpt_web|GPT-5.6 Sol')).toEqual(['chatgpt_web|Medium']);
  });
});

describe('fetchModelList', () => {
  const base = { baseUrl: 'https://x.test/v1', apiKey: 'k', authScheme: 'bearer' as const };

  it('returns sorted ids and reasoning support', async () => {
    const list = await fetchModelList({
      ...base,
      fetch: listFetch({
        data: [
          { id: 'b', supported_parameters: ['reasoning'] },
          { id: 'a', supported_parameters: ['temperature'] },
          { id: 5 },
        ],
      }),
    });
    expect(list).toEqual([
      { id: 'a', reasoning: false },
      { id: 'b', reasoning: true },
    ]);
  });

  it('returns null, never throws, when the list is unavailable', async () => {
    expect(await fetchModelList({ ...base, fetch: listFetch({}, 401) })).toBeNull();
    expect(
      await fetchModelList({
        ...base,
        fetch: async () => {
          throw new TypeError('offline');
        },
      }),
    ).toBeNull();
    expect(await fetchModelList({ ...base, fetch: listFetch({ data: [] }) })).toBeNull();
  });
});

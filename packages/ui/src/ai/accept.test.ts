import { describe, expect, it } from 'vitest';
import type { AiResult } from '@ai';
import { renderMarkdown } from '../vault/markdownRender';
import { toMarkdown } from './accept';

/** The fields `toMarkdown` reads of a summary; the rest of the stored shape is not its concern. */
const summary = (text: string): AiResult =>
  ({
    kind: 'summary',
    provider: 'mock',
    model: 'mock-1',
    createdAt: '2026-10-11T10:00:00.000Z',
    notices: [],
    citations: [],
    output: { summary: text, keyPoints: ['costs $5 and $10', 'see $a_1$'], evidence: [] },
  }) as unknown as AiResult;

describe('toMarkdown: dollar signs in model text', () => {
  it('escapes them, so model text is never turned into a math span', () => {
    const body = toMarkdown(summary('Energy is $E = mc^2$ here.'), new Map());
    expect(body).toContain(String.raw`Energy is \$E = mc^2\$ here.`);
    expect(body).toContain(String.raw`see \$a\_1\$`);

    const holder = document.createElement('div');
    holder.append(renderMarkdown(body));
    expect(holder.querySelector('code.math')).toBeNull();
    // The reader still sees the text as the model wrote it.
    expect(holder.textContent).toContain('Energy is $E = mc^2$ here.');
    expect(holder.textContent).toContain('see $a_1$');
  });
});

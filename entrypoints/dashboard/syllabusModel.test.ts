// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  MAX_SYLLABUS_DEPTH,
  MAX_SYLLABUS_NODES,
  Syllabus,
  type SyllabusNode,
  flattenSyllabus,
} from '@shared';
import {
  OUTLINE_MAX_CHARS,
  addTopic,
  bankTopics,
  countTopics,
  findTopic,
  moveTopic,
  outlineToInputs,
  parseOutline,
  parseWeightInput,
  removeTopic,
  syllabusToMarkdown,
  updateTopic,
  type Edit,
} from './syllabusModel';

const node = (id: string, children: SyllabusNode[] = [], over: Partial<SyllabusNode> = {}) => ({
  id: `${id}-0000000`,
  title: id,
  children,
  bankIds: [],
  tagIds: [],
  ...over,
});
const id = (name: string) => `${name}-0000000`;
const titles = (nodes: readonly SyllabusNode[]): string[] =>
  flattenSyllabus(nodes).map((x) => `${'>'.repeat(x.depth - 1)}${x.node.title}`);
const ok = (edit: Edit): SyllabusNode[] => {
  if (!edit.ok) throw new Error(edit.reason);
  return edit.nodes;
};
const reason = (edit: Edit): string => (edit.ok ? 'ok' : edit.reason);

/** a (a1, a2 (a2x)), b, c */
const sample = () => [node('a', [node('a1'), node('a2', [node('a2x')])]), node('b'), node('c')];

describe('editing a tree', () => {
  it('adds a subtopic, a following sibling and a top-level topic, selecting the new one', () => {
    const base = sample();
    const child = addTopic(base, id('b'), 'child', 'Pharmacology');
    expect(titles(ok(child))).toEqual(['a', '>a1', '>a2', '>>a2x', 'b', '>Pharmacology', 'c']);
    expect(child.ok && child.select).toBeTruthy();
    expect(titles(ok(addTopic(base, id('a'), 'after')))).toEqual([
      'a',
      '>a1',
      '>a2',
      '>>a2x',
      'New topic',
      'b',
      'c',
    ]);
    expect(titles(ok(addTopic(base, null, 'after')))).toEqual([
      'a',
      '>a1',
      '>a2',
      '>>a2x',
      'b',
      'c',
      'New topic',
    ]);
    // The input was not touched, and the result is a valid syllabus.
    expect(titles(base)).toHaveLength(6);
    expect(
      Syllabus.safeParse({
        id: 'syl-0000001',
        schemaVersion: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        deletedAt: null,
        name: 'x',
        nodes: ok(child),
      }).success,
    ).toBe(true);
  });

  it('refuses a seventh level and a 501st topic, in the words of the limits', () => {
    let deep: SyllabusNode = node('l6');
    for (let level = 5; level >= 1; level -= 1) deep = node(`l${level}`, [deep]);
    expect(reason(addTopic([deep], id('l6'), 'child'))).toBe(
      `Topics can be nested at most ${MAX_SYLLABUS_DEPTH} levels deep.`,
    );
    // A sibling at the deepest level is fine.
    expect(addTopic([deep], id('l6'), 'after').ok).toBe(true);

    const full = Array.from({ length: MAX_SYLLABUS_NODES }, (_, i) => node(`t${i}`));
    expect(reason(addTopic(full, null, 'after'))).toBe(
      `A syllabus holds at most ${MAX_SYLLABUS_NODES} topics.`,
    );
    expect(reason(addTopic(sample(), 'gone-0000000', 'child'))).toMatch(/no longer/);
  });

  it('renames, sets and clears a weight, and keeps mappings', () => {
    const base = sample();
    const renamed = ok(updateTopic(base, id('b'), { title: '  Renal  ', weight: 2.5 }));
    expect(findTopic(renamed, id('b'))).toMatchObject({ title: 'Renal', weight: 2.5 });
    const cleared = ok(updateTopic(renamed, id('b'), { weight: null }));
    expect(findTopic(cleared, id('b'))).not.toHaveProperty('weight');
    const mapped = ok(
      updateTopic(base, id('c'), { bankIds: ['bank-0000001'], tagIds: ['tag-0000001'] }),
    );
    expect(findTopic(mapped, id('c'))).toMatchObject({
      bankIds: ['bank-0000001'],
      tagIds: ['tag-0000001'],
    });
    expect(reason(updateTopic(base, id('b'), { title: '   ' }))).toMatch(/needs a title/);
    expect(reason(updateTopic(base, id('b'), { title: 'x'.repeat(201) }))).toMatch(/at most 200/);
    expect(
      reason(
        updateTopic(base, id('b'), { bankIds: Array.from({ length: 51 }, (_, i) => `b${i}`) }),
      ),
    ).toMatch(/at most 50 banks/);
  });

  it('removes a topic with its subtopics and selects its neighbour', () => {
    const r = removeTopic(sample(), id('a'));
    expect(titles(ok(r))).toEqual(['b', 'c']);
    expect(r.ok && r.select).toBe(id('b'));
    const last = removeTopic(sample(), id('c'));
    expect(last.ok && last.select).toBe(id('b'));
    const inner = removeTopic(sample(), id('a2x'));
    expect(inner.ok && inner.select).toBe(id('a2'));
  });

  it('moves up and down among siblings and says when it cannot', () => {
    expect(titles(ok(moveTopic(sample(), id('b'), 'up')))).toEqual([
      'b',
      'a',
      '>a1',
      '>a2',
      '>>a2x',
      'c',
    ]);
    expect(titles(ok(moveTopic(sample(), id('a'), 'down')))).toEqual([
      'b',
      'a',
      '>a1',
      '>a2',
      '>>a2x',
      'c',
    ]);
    expect(reason(moveTopic(sample(), id('a'), 'up'))).toBe(
      'Already the first topic at this level.',
    );
    expect(reason(moveTopic(sample(), id('c'), 'down'))).toBe(
      'Already the last topic at this level.',
    );
  });

  it('indents under the sibling above and outdents after the parent', () => {
    expect(titles(ok(moveTopic(sample(), id('b'), 'indent')))).toEqual([
      'a',
      '>a1',
      '>a2',
      '>>a2x',
      '>b',
      'c',
    ]);
    expect(titles(ok(moveTopic(sample(), id('a2'), 'outdent')))).toEqual([
      'a',
      '>a1',
      'a2',
      '>a2x',
      'b',
      'c',
    ]);
    expect(reason(moveTopic(sample(), id('a'), 'indent'))).toMatch(/no topic above/);
    expect(reason(moveTopic(sample(), id('a'), 'outdent'))).toBe('Already at the top level.');
  });

  it('refuses an indent that would push a subtree below the sixth level', () => {
    // a > a1 > a11 > a111 > a1111 (5 levels) and a sibling "z" with one child: indenting z under a
    // is fine; indenting "z" (height 2) under the 5-level-deep a1111 is not.
    const tree = [
      node('a', [node('a1', [node('a11', [node('a111', [node('a1111')])])])]),
      node('z', [node('z1')]),
    ];
    expect(moveTopic(tree, id('z'), 'indent').ok).toBe(true);
    const deepTree = [
      node('a', [
        node('a1', [node('a11', [node('a111', [node('a1111'), node('y', [node('y1')])])])]),
      ]),
    ];
    expect(reason(moveTopic(deepTree, id('y'), 'indent'))).toBe(
      `Topics can be nested at most ${MAX_SYLLABUS_DEPTH} levels deep.`,
    );
    expect(countTopics(deepTree)).toBe(7);
  });
});

describe('weights', () => {
  it('accepts a positive number or nothing, and says what is allowed otherwise', () => {
    expect(parseWeightInput('')).toEqual({ ok: true, weight: null });
    expect(parseWeightInput(' 2.5 ')).toEqual({ ok: true, weight: 2.5 });
    expect(parseWeightInput('1000')).toEqual({ ok: true, weight: 1000 });
    for (const bad of ['0', '-1', '1001', 'abc', '1e3', '1,5', '0.0']) {
      const r = parseWeightInput(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/above 0 and at most 1000/);
    }
  });
});

describe('reading an outline', () => {
  it('reads nested bullets, numbered items and plain indented lines', () => {
    const r = parseOutline(
      [
        '- Cardiology',
        '  - Heart failure',
        '    - Drugs',
        '  * Arrhythmia',
        '2. Renal',
        '   Acute kidney injury',
      ].join('\n'),
    );
    expect(r.errors).toEqual([]);
    expect(r.count).toBe(6);
    expect(r.depth).toBe(3);
    expect(r.topics.map((t) => t.title)).toEqual(['Cardiology', 'Renal']);
    expect(r.topics[0]?.children.map((t) => t.title)).toEqual(['Heart failure', 'Arrhythmia']);
    expect(r.topics[0]?.children[0]?.children[0]?.title).toBe('Drugs');
    expect(r.topics[1]?.children[0]?.title).toBe('Acute kidney injury');
  });

  it('reads headings as levels and a single leading # as the name', () => {
    const r = parseOutline(
      '# Cardiology exam\n\n## Physiology\n- Preload\n- Afterload\n## Pharmacology',
    );
    expect(r.name).toBe('Cardiology exam');
    expect(r.topics.map((t) => t.title)).toEqual(['Physiology', 'Pharmacology']);
    expect(r.topics[0]?.children.map((t) => t.title)).toEqual(['Preload', 'Afterload']);

    // Several top-level headings are topics, not a name.
    const many = parseOutline('# One\n# Two\n## Two A');
    expect(many.name).toBeNull();
    expect(many.topics.map((t) => t.title)).toEqual(['One', 'Two']);
    expect(many.topics[1]?.children[0]?.title).toBe('Two A');
  });

  it('reads weights, counts tabs as four spaces and reports what it interpreted', () => {
    const r = parseOutline('- A (weight 3)\n\t- B (w: 0.5)\n\t\t\t- C\n    - D');
    expect(r.errors).toEqual([]);
    expect(r.topics[0]).toMatchObject({ title: 'A', weight: 3 });
    expect(r.topics[0]?.children[0]).toMatchObject({ title: 'B', weight: 0.5 });
    // C is three tabs in: a deeper level, but only one level below B.
    expect(r.topics[0]?.children[0]?.children[0]?.title).toBe('C');
    // D has the same indent as B (4 spaces): B's sibling.
    expect(r.topics[0]?.children.map((t) => t.title)).toEqual(['B', 'D']);
  });

  it('blocks an import with specific, line-numbered errors', () => {
    const tooDeep = parseOutline(
      Array.from({ length: 8 }, (_, i) => `${'  '.repeat(i)}- level ${i + 1}`).join('\n'),
    );
    expect(tooDeep.errors).toEqual([
      {
        line: 7,
        message: `A topic is nested 8 levels deep; at most ${MAX_SYLLABUS_DEPTH} are allowed.`,
      },
    ]);

    const many = parseOutline(Array.from({ length: 501 }, (_, i) => `- t${i}`).join('\n'));
    expect(many.errors.map((e) => e.message)).toEqual([
      `The outline has 501 topics; a syllabus holds at most ${MAX_SYLLABUS_NODES}.`,
    ]);

    const bad = parseOutline(`- ${'x'.repeat(201)}\n- Fine (weight 0)\n- Heavy (weight 5000)`);
    expect(bad.errors).toEqual([
      { line: 1, message: 'The title is longer than 200 characters.' },
      { line: 2, message: 'The weight must be above 0 and at most 1000.' },
      { line: 3, message: 'The weight must be above 0 and at most 1000.' },
    ]);

    expect(parseOutline('x'.repeat(OUTLINE_MAX_CHARS + 1)).errors[0]?.message).toMatch(
      /longer than 100,000/,
    );
    expect(parseOutline('- a\n'.repeat(2001)).errors[0]?.message).toMatch(/more than 2,000 lines/);
  });

  it('says nothing is there for empty text and survives hostile input', () => {
    expect(parseOutline('')).toMatchObject({ count: 0, errors: [], topics: [] });
    expect(parseOutline('  \n\t\n-\n*\n')).toMatchObject({ count: 0, errors: [] });
    const hostile = parseOutline(
      `<img src=x onerror=alert(1)>\n${' '.repeat(5000)}- ${'<script>'.repeat(5)}\n__proto__\n- constructor`,
    );
    expect(hostile.errors).toEqual([]);
    // Markup stays text: nothing is interpreted.
    expect(hostile.topics[0]?.title).toBe('<img src=x onerror=alert(1)>');
    expect(Object.getPrototypeOf(hostile.topics[0])).toBe(Object.prototype);
  });

  it('clamps a jump of two levels and tells the person', () => {
    const r = parseOutline('## A\n#### C');
    expect(r.notes).toEqual([
      {
        line: 2,
        message: 'This line skips a level; it was placed one level below the line above.',
      },
    ]);
    expect(r.topics[0]?.children[0]?.title).toBe('C');
    expect(r.count).toBe(2);
    expect(r.errors).toEqual([]);
    expect(r.name).toBeNull();
  });
});

describe('writing an outline', () => {
  it('exports titles and weights as Markdown that reads back to the same tree', () => {
    const tree = [
      node('Cardiology', [node('Heart failure', [node('Drugs')], { weight: 2 }), node('Rhythm')], {
        weight: 3,
      }),
      node('Renal'),
    ];
    const md = syllabusToMarkdown('My exam', tree);
    expect(md).toBe(
      [
        '# My exam',
        '',
        '- Cardiology (weight 3)',
        '  - Heart failure (weight 2)',
        '    - Drugs',
        '  - Rhythm',
        '- Renal',
        '',
      ].join('\n'),
    );
    const back = parseOutline(md);
    expect(back.name).toBe('My exam');
    expect(back.errors).toEqual([]);
    const again = syllabusToMarkdown(
      back.name ?? '',
      outlineToInputs(back.topics).map(function build(t): SyllabusNode {
        return {
          id: 'x-0000000',
          title: t.title,
          children: (t.children ?? []).map(build),
          bankIds: [],
          tagIds: [],
          ...(t.weight === undefined ? {} : { weight: t.weight }),
        };
      }),
    );
    expect(again).toBe(md);
  });

  it('keeps a title that looks like markup or a list marker intact on the way out and in', () => {
    const tree = [node('1. Intro', [], {}), node('# not a heading'), node('- dash')];
    const back = parseOutline(syllabusToMarkdown('N', tree));
    expect(back.topics.map((t) => t.title)).toEqual(['1. Intro', '# not a heading', '- dash']);
  });

  it('starts from the banks: one topic per bank, never the Inbox', () => {
    const inputs = bankTopics([
      { id: 'inbox-default', name: 'Inbox', isInbox: true },
      { id: 'bank-0000001', name: 'Cardiology', isInbox: false },
      { id: 'bank-0000002', name: '  Renal\nmedicine ', isInbox: false },
    ]);
    expect(inputs).toEqual([
      { title: 'Cardiology', bankIds: ['bank-0000001'] },
      { title: 'Renal medicine', bankIds: ['bank-0000002'] },
    ]);
    expect(bankTopics([{ id: 'inbox-default', name: 'Inbox', isInbox: true }])).toEqual([]);
  });
});

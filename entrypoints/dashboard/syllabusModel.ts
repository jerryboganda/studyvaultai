import { uuidv7 } from 'uuidv7';
import {
  MAX_SYLLABUS_DEPTH,
  MAX_SYLLABUS_LINKS,
  MAX_SYLLABUS_NODES,
  MAX_SYLLABUS_TITLE_CHARS,
  MAX_SYLLABUS_WEIGHT,
  flattenSyllabus,
  measureSyllabus,
  type SyllabusNode,
} from '@shared';
import type { SyllabusNodeInput } from '@storage';

/**
 * The syllabus editor's rules as pure functions over a tree (no React, no storage): edits, the
 * limits the schema enforces (said before the vault would refuse), the outline text format and the
 * one-click starting point. Every edit returns a NEW tree; the input is never touched.
 */

export const NEW_TOPIC_TITLE = 'New topic';
const TREE_FULL = `A syllabus holds at most ${MAX_SYLLABUS_NODES} topics.`;
const TOO_DEEP = `Topics can be nested at most ${MAX_SYLLABUS_DEPTH} levels deep.`;

export type Edit =
  { ok: true; nodes: SyllabusNode[]; select: string | null } | { ok: false; reason: string };

const fail = (reason: string): Edit => ({ ok: false, reason });
const done = (nodes: SyllabusNode[], select: string | null = null): Edit => ({
  ok: true,
  nodes,
  select,
});

interface Located {
  list: SyllabusNode[];
  index: number;
  parent: SyllabusNode | null;
  /** 1 at the top level. */
  depth: number;
}

function locate(
  nodes: SyllabusNode[],
  id: string,
  depth = 1,
  parent: SyllabusNode | null = null,
): Located | null {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index] as SyllabusNode;
    if (node.id === id) return { list: nodes, index, parent, depth };
    const inner = locate(node.children, id, depth + 1, node);
    if (inner) return inner;
  }
  return null;
}

/** Levels in the subtree rooted at `node`, itself included. */
export const heightOf = (node: SyllabusNode): number =>
  1 + node.children.reduce((h, c) => Math.max(h, heightOf(c)), 0);

export const countTopics = (nodes: readonly SyllabusNode[]): number => measureSyllabus(nodes).count;

/** Topics in reading order with their depth (1 = top level), for the tree and the pickers. */
export const flatTopics = (nodes: readonly SyllabusNode[]) =>
  flattenSyllabus(nodes).map(({ node, depth, parentId }) => ({ node, depth, parentId }));

export function findTopic(nodes: readonly SyllabusNode[], id: string | null): SyllabusNode | null {
  if (id === null) return null;
  return flattenSyllabus(nodes).find((x) => x.node.id === id)?.node ?? null;
}

// ---------------------------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------------------------

/** Why a topic cannot be added there (no new id is made), or undefined when it can. */
export function addBlocked(
  nodes: readonly SyllabusNode[],
  anchorId: string | null,
  where: 'child' | 'after',
): string | undefined {
  if (countTopics(nodes) >= MAX_SYLLABUS_NODES) return TREE_FULL;
  if (anchorId === null) return undefined;
  const at = locate(nodes as SyllabusNode[], anchorId);
  if (!at) return 'That topic is no longer in the syllabus.';
  return where === 'child' && at.depth >= MAX_SYLLABUS_DEPTH ? TOO_DEEP : undefined;
}

/** A new topic: under `anchorId` (`child`), right after it (`after`), or last at the top level. */
export function addTopic(
  nodes: readonly SyllabusNode[],
  anchorId: string | null,
  where: 'child' | 'after',
  title = NEW_TOPIC_TITLE,
): Edit {
  const blocked = addBlocked(nodes, anchorId, where);
  if (blocked) return fail(blocked);
  const next = structuredClone(nodes) as SyllabusNode[];
  const fresh: SyllabusNode = { id: uuidv7(), title, children: [], bankIds: [], tagIds: [] };
  if (anchorId === null) {
    next.push(fresh);
    return done(next, fresh.id);
  }
  const at = locate(next, anchorId) as Located;
  if (where === 'child') {
    (at.list[at.index] as SyllabusNode).children.push(fresh);
  } else {
    at.list.splice(at.index + 1, 0, fresh);
  }
  return done(next, fresh.id);
}

/** Change one topic. Returns the same tree when nothing differs. */
export function updateTopic(
  nodes: readonly SyllabusNode[],
  id: string,
  patch: Partial<Pick<SyllabusNode, 'title' | 'bankIds' | 'tagIds'>> & { weight?: number | null },
): Edit {
  const next = structuredClone(nodes) as SyllabusNode[];
  const at = locate(next, id);
  if (!at) return fail('That topic is no longer in the syllabus.');
  const node = at.list[at.index] as SyllabusNode;
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (title === '') return fail('A topic needs a title.');
    if (title.length > MAX_SYLLABUS_TITLE_CHARS) {
      return fail(`A title is at most ${MAX_SYLLABUS_TITLE_CHARS} characters.`);
    }
    node.title = title;
  }
  if (patch.bankIds !== undefined) {
    if (patch.bankIds.length > MAX_SYLLABUS_LINKS) {
      return fail(`A topic points at most ${MAX_SYLLABUS_LINKS} banks.`);
    }
    node.bankIds = [...patch.bankIds];
  }
  if (patch.tagIds !== undefined) {
    if (patch.tagIds.length > MAX_SYLLABUS_LINKS) {
      return fail(`A topic points at most ${MAX_SYLLABUS_LINKS} tags.`);
    }
    node.tagIds = [...patch.tagIds];
  }
  if (patch.weight !== undefined) {
    if (patch.weight === null) delete node.weight;
    else node.weight = patch.weight;
  }
  return done(next, id);
}

/** Remove a topic and everything below it. */
export function removeTopic(nodes: readonly SyllabusNode[], id: string): Edit {
  const next = structuredClone(nodes) as SyllabusNode[];
  const at = locate(next, id);
  if (!at) return fail('That topic is no longer in the syllabus.');
  at.list.splice(at.index, 1);
  // Select what was beside it, so keyboard work continues in place.
  const beside = at.list[at.index] ?? at.list[at.index - 1] ?? at.parent;
  return done(next, beside?.id ?? null);
}

export type MoveDirection = 'up' | 'down' | 'indent' | 'outdent';

/**
 * Up/down swap with a sibling. Indent makes the topic the last subtopic of the sibling above;
 * outdent makes it the sibling right after its parent. A move the limits forbid says why.
 */
export function moveTopic(
  nodes: readonly SyllabusNode[],
  id: string,
  direction: MoveDirection,
): Edit {
  const next = structuredClone(nodes) as SyllabusNode[];
  const at = locate(next, id);
  if (!at) return fail('That topic is no longer in the syllabus.');
  const { list, index } = at;
  const node = list[index] as SyllabusNode;

  if (direction === 'up' || direction === 'down') {
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0) return fail('Already the first topic at this level.');
    if (target >= list.length) return fail('Already the last topic at this level.');
    [list[index], list[target]] = [list[target] as SyllabusNode, node];
    return done(next, id);
  }
  if (direction === 'indent') {
    const above = list[index - 1];
    if (!above) return fail('There is no topic above to move this one into.');
    if (at.depth + heightOf(node) > MAX_SYLLABUS_DEPTH) return fail(TOO_DEEP);
    list.splice(index, 1);
    above.children.push(node);
    return done(next, id);
  }
  if (at.parent === null) return fail('Already at the top level.');
  const holder = locate(next, at.parent.id) as Located;
  list.splice(index, 1);
  holder.list.splice(holder.index + 1, 0, node);
  return done(next, id);
}

/** Weight text -> a number, or null for "equal share". */
export function parseWeightInput(
  text: string,
): { ok: true; weight: number | null } | { ok: false; message: string } {
  const t = text.trim();
  if (t === '') return { ok: true, weight: null };
  const message = `Use a number above 0 and at most ${MAX_SYLLABUS_WEIGHT}, or leave it empty for an equal share.`;
  if (!/^\d+(\.\d+)?$/.test(t)) return { ok: false, message };
  const weight = Number(t);
  return weight > 0 && weight <= MAX_SYLLABUS_WEIGHT
    ? { ok: true, weight }
    : { ok: false, message };
}

// ---------------------------------------------------------------------------------------------
// Outline text
// ---------------------------------------------------------------------------------------------

export const OUTLINE_MAX_CHARS = 100_000;
export const OUTLINE_MAX_LINES = 2_000;

export interface OutlineTopic {
  title: string;
  weight?: number;
  children: OutlineTopic[];
}
export interface OutlineIssue {
  /** 1-based; 0 for a problem of the whole text. */
  line: number;
  message: string;
}
export interface OutlineParse {
  /** From a single leading `# Title` line; null otherwise. */
  name: string | null;
  topics: OutlineTopic[];
  count: number;
  depth: number;
  /** Anything here blocks the import. */
  errors: OutlineIssue[];
  /** What was interpreted rather than read literally; never blocks. */
  notes: OutlineIssue[];
}

const WEIGHT_SUFFIX = /\s*\((?:weight|w)\s*[:=]?\s*(\d+(?:\.\d+)?)\)\s*$/i;
const BULLET = /^(?:[-*+]|\d+[.)])\s+/;
const BARE_MARKER = /^(?:[-*+]|\d+[.)])$/;
const HEADING = /^(#{1,6})\s+(.*)$/;

interface RawLine {
  line: number;
  indent: number;
  heading: number | null;
  title: string;
  weight: number | undefined;
}

/**
 * Read an outline: nested bullet or numbered lists, plain indented lines, and Markdown headings
 * (`#` per level; a single leading `# Title` names the syllabus). Indentation is counted in spaces
 * (a tab is four); a topic's level is its position in the chain of indents seen so far. A trailing
 * `(weight 2)` sets a weight. Nothing is executed or rendered as markup: titles are plain text.
 */
export function parseOutline(text: string): OutlineParse {
  const empty = (errors: OutlineIssue[] = []): OutlineParse => ({
    name: null,
    topics: [],
    count: 0,
    depth: 0,
    errors,
    notes: [],
  });
  if (text.length > OUTLINE_MAX_CHARS) {
    return empty([
      {
        line: 0,
        message: `The text is longer than ${OUTLINE_MAX_CHARS.toLocaleString()} characters.`,
      },
    ]);
  }
  const rows = text.split(/\r\n|\r|\n/);
  if (rows.length > OUTLINE_MAX_LINES) {
    return empty([
      { line: 0, message: `The text has more than ${OUTLINE_MAX_LINES.toLocaleString()} lines.` },
    ]);
  }
  const errors: OutlineIssue[] = [];
  const notes: OutlineIssue[] = [];

  const lines: RawLine[] = [];
  rows.forEach((raw, i) => {
    if (raw.trim() === '') return;
    const line = i + 1;
    const lead = /^\s*/.exec(raw)?.[0] ?? '';
    const indent = lead.replace(/\t/g, '    ').length;
    let body = raw.trim();
    let heading: number | null = null;
    const h = HEADING.exec(body);
    if (h) {
      heading = (h[1] as string).length;
      body = (h[2] as string).trim();
    } else if (BARE_MARKER.test(body)) {
      return;
    } else {
      body = body.replace(BULLET, '').trim();
    }
    let weight: number | undefined;
    const w = WEIGHT_SUFFIX.exec(body);
    if (w) {
      weight = Number(w[1]);
      body = body.slice(0, w.index).trim();
      if (!(weight > 0) || weight > MAX_SYLLABUS_WEIGHT) {
        errors.push({
          line,
          message: `The weight must be above 0 and at most ${MAX_SYLLABUS_WEIGHT}.`,
        });
        weight = undefined;
      }
    }
    if (body === '') return;
    if (body.length > MAX_SYLLABUS_TITLE_CHARS) {
      errors.push({
        line,
        message: `The title is longer than ${MAX_SYLLABUS_TITLE_CHARS} characters.`,
      });
    }
    lines.push({ line, indent, heading, title: body, weight });
  });

  // A single leading "# Title" is the syllabus name, not a topic.
  let name: string | null = null;
  const first = lines[0];
  if (first && first.heading === 1 && lines.filter((l) => l.heading === 1).length === 1) {
    name = first.title.slice(0, 120);
    lines.shift();
  }

  const headingLevels = lines.flatMap((l) => (l.heading === null ? [] : [l.heading]));
  const minHeading = headingLevels.length > 0 ? Math.min(...headingLevels) : 1;
  const stack: number[] = [];
  let base = 0;
  let previous = 0;
  const placed: Array<{ item: RawLine; depth: number }> = [];
  for (const item of lines) {
    let depth: number;
    if (item.heading !== null) {
      depth = item.heading - minHeading + 1;
      base = depth;
      stack.length = 0;
    } else {
      let dropped = false;
      while (stack.length > 0 && (stack[stack.length - 1] as number) > item.indent) {
        stack.pop();
        dropped = true;
      }
      const top = stack[stack.length - 1];
      if (top === undefined || top < item.indent) {
        if (dropped && top !== undefined) {
          notes.push({
            line: item.line,
            message: 'The indentation does not match an earlier line; it was read as a new level.',
          });
        }
        stack.push(item.indent);
      }
      depth = base + stack.length;
    }
    if (depth > previous + 1) {
      if (previous > 0) {
        notes.push({
          line: item.line,
          message: 'This line skips a level; it was placed one level below the line above.',
        });
      }
      depth = previous + 1;
    }
    previous = depth;
    placed.push({ item, depth });
  }

  // Build the tree.
  const topics: OutlineTopic[] = [];
  const chain: OutlineTopic[] = [];
  let deepest = 0;
  for (const { item, depth } of placed) {
    const topic: OutlineTopic = {
      title: item.title,
      ...(item.weight === undefined ? {} : { weight: item.weight }),
      children: [],
    };
    chain.length = depth - 1;
    const owner = chain[depth - 2];
    (owner ? owner.children : topics).push(topic);
    chain[depth - 1] = topic;
    deepest = Math.max(deepest, depth);
  }

  if (deepest > MAX_SYLLABUS_DEPTH) {
    const at = placed.find((p) => p.depth > MAX_SYLLABUS_DEPTH);
    errors.push({
      line: at?.item.line ?? 0,
      message: `A topic is nested ${deepest} levels deep; at most ${MAX_SYLLABUS_DEPTH} are allowed.`,
    });
  }
  if (placed.length > MAX_SYLLABUS_NODES) {
    errors.push({
      line: 0,
      message: `The outline has ${placed.length.toLocaleString()} topics; a syllabus holds at most ${MAX_SYLLABUS_NODES}.`,
    });
  }
  return { name, topics, count: placed.length, depth: deepest, errors, notes };
}

/** An outline as the inputs `createSyllabus` takes (ids are made by the vault). */
export function outlineToInputs(topics: readonly OutlineTopic[]): SyllabusNodeInput[] {
  return topics.map((t) => ({
    title: t.title,
    ...(t.weight === undefined ? {} : { weight: t.weight }),
    children: outlineToInputs(t.children),
  }));
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * The outline as Markdown: titles and weights only. Banks and tags are specific to one vault (their
 * ids mean nothing elsewhere), so they are not part of the text; `parseOutline` reads this back.
 */
export function syllabusToMarkdown(name: string, nodes: readonly SyllabusNode[]): string {
  const out = [`# ${oneLine(name)}`, ''];
  for (const { node, depth } of flattenSyllabus(nodes)) {
    const weight = node.weight === undefined ? '' : ` (weight ${node.weight})`;
    out.push(`${'  '.repeat(depth - 1)}- ${oneLine(node.title)}${weight}`);
  }
  return `${out.join('\n')}\n`;
}

/** "Start from my banks": one topic per bank (the Inbox is a holding place, not a topic). */
export function bankTopics(
  banks: readonly { id: string; name: string; isInbox: boolean }[],
): SyllabusNodeInput[] {
  return banks
    .filter((b) => !b.isInbox)
    .slice(0, MAX_SYLLABUS_NODES)
    .map((b) => ({
      title: oneLine(b.name).slice(0, MAX_SYLLABUS_TITLE_CHARS),
      bankIds: [b.id],
    }));
}

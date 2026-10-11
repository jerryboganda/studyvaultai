import type { RelationEntityKind, RelationType } from '@shared';

/** Words for links: the same in the list of links, the graph and its legend. */

export const KIND_NAME: Record<RelationEntityKind, string> = {
  highlight: 'Highlight',
  note: 'Note',
  knowledgePoint: 'Knowledge point',
};

export const TYPE_NAME: Record<RelationType, string> = {
  related: 'Related',
  supports: 'Supports',
  contradicts: 'Contradicts',
  cause: 'Cause',
  example: 'Example',
  prerequisite: 'Prerequisite',
};

/** One line saying what the type means, read from the start of the link to its end. */
export const TYPE_MEANING: Record<RelationType, string> = {
  related: 'The two belong together. No direction.',
  supports: 'The first backs up the second.',
  contradicts: 'The first disagrees with the second.',
  cause: 'The first leads to the second.',
  example: 'The first is an example of the second.',
  prerequisite: 'The first must be understood before the second.',
};

const OUT: Record<RelationType, string> = {
  related: 'Related to',
  supports: 'Supports',
  contradicts: 'Contradicts',
  cause: 'Causes',
  example: 'Is an example of',
  prerequisite: 'Is a prerequisite of',
};

const IN: Record<RelationType, string> = {
  related: 'Related to',
  supports: 'Supported by',
  contradicts: 'Contradicted by',
  cause: 'Caused by',
  example: 'Has the example',
  prerequisite: 'Has the prerequisite',
};

/** How an item stands to the other end of a link: "Supports", "Supported by", ... */
export const phrase = (type: RelationType, direction: 'out' | 'in'): string =>
  direction === 'out' ? OUT[type] : IN[type];

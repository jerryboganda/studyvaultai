// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { STUDYVAULT_SYNC_POLICY, checkPolicy, serializeRow } from '@sync';
import './ai'; // registers the aiResults schema
import './study'; // registers decks, knowledgePoints, cards and reviewLogs
import { tableRegistry, unregisteredTables } from './registry';
import { activeSyncPolicy } from './sync';

/**
 * The cross-check that keeps the sync policy honest, part of the ordinary unit suite: the policy
 * (packages/sync/src/policy.ts, the single source of truth) against the schemas that the owning
 * modules registered. This file loads those modules, so it sees the registry the extension has at
 * run time.
 */

/** Schema fields that no policy list names: they merge field by field, last writer wins, on purpose. */
const SCALARS: Record<string, readonly string[]> = {
  banks: ['name', 'color', 'position', 'isInbox', 'icon'],
  sources: ['documentId', 'title'],
  highlights: ['kind', 'color', 'priority'],
  highlightBanks: ['folderId', 'addedAt'],
  folders: ['parentFolderId', 'name', 'position'],
  tags: ['name', 'nameKey', 'color'],
  highlightTags: ['addedAt'],
  notes: ['highlightId', 'sourceId', 'pinned'],
  knowledgePoints: [
    'highlightId',
    'primaryQuoteId',
    'verificationStatus',
    'createdBy',
    'acceptedAt',
  ],
  decks: ['bankId'],
  cards: [
    'deckId',
    'knowledgePointId',
    'highlightId',
    'cardType',
    'answerChoiceId',
    'suspended',
    'buriedUntil',
    'needsHumanVerification',
    'dueAt',
    'fsrs',
    'createdBy',
    'aiResultId',
  ],
  documents: ['pageCount', 'byteLength', 'originalUrl', 'textStatus'],
  ocrPages: ['text', 'words', 'language', 'engine', 'confidence', 'orientation'],
  // `order` is a rank (a concurrent re-ordering ends with the later write per rule; ties are
  // broken by age and id), the two flags are on/off switches: all three are short scalars.
  filingRules: ['enabled', 'order', 'requireConfirm'],
};
/** Present on every row of a soft-deletable table; never free text. */
const ROW_META = ['id', 'createdAt', 'updatedAt', 'deletedAt', 'schemaVersion'];

describe('sync policy against every registered schema', () => {
  it('has no drift: the policy the extension runs with matches the real schemas', () => {
    const active = activeSyncPolicy();
    const tables = active.tables.map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'banks',
        'folders',
        'tags',
        'sources',
        'highlights',
        'highlightBanks',
        'highlightTags',
        'notes',
        'knowledgePoints',
        'decks',
        'cards',
        'reviewLogs',
        'documents',
        'ocrPages',
        'filingRules',
        'syllabi',
        'relations',
        'gameFacts',
      ]),
    );
    expect(active.notSynced).toEqual([]);
    const named = Object.fromEntries(
      Object.entries(STUDYVAULT_SYNC_POLICY).filter(([t]) => tables.includes(t)),
    );
    expect(checkPolicy(tableRegistry, named)).toEqual([]);
  });

  it('classifies every schema field: a new free-text field cannot silently merge last-writer-wins', () => {
    const unclassified: string[] = [];
    const stale: string[] = [];
    for (const spec of activeSyncPolicy().tables) {
      const policy = STUDYVAULT_SYNC_POLICY[spec.name]!;
      if (policy.appendOnly) continue; // every field of an append-only entity is frozen
      const shape = (spec.schema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
      const named = new Set([
        ...(policy.immutable ?? []),
        ...(policy.text ?? []),
        ...(policy.sets ?? []),
        ...(policy.local ?? []),
        ...(spec.derivedFields ?? []),
        ...ROW_META,
        ...(SCALARS[spec.name] ?? []),
      ]);
      for (const field of Object.keys(shape)) {
        if (!named.has(field)) unclassified.push(`${spec.name}.${field}`);
      }
      for (const field of SCALARS[spec.name] ?? []) {
        if (!(field in shape)) stale.push(`${spec.name}.${field}`);
      }
    }
    // Fix: name the field under immutable/text/sets/local in packages/sync/src/policy.ts, or, for a
    // short scalar that may be last-writer-wins, add it to SCALARS above.
    expect(unclassified).toEqual([]);
    expect(stale).toEqual([]);
  });

  it('keeps provenance and append-only data protected', () => {
    const { policy } = activeSyncPolicy();
    expect(policy.highlights!.immutable).toEqual(
      expect.arrayContaining(['exactQuote', 'anchorSet', 'quoteHash', 'sourceId']),
    );
    expect(policy.cards!.immutable).toContain('sourceQuote');
    expect(policy.reviewLogs!.appendOnly).toBe(true);
    // game facts are append-only: an undo or a goal change is a new row, never an edit
    expect(policy.gameFacts!.appendOnly).toBe(true);
    // free text is never merged last-writer-wins without a record of the other side
    expect(policy.notes!.text).toEqual(expect.arrayContaining(['title', 'body']));
    expect(policy.highlights!.text).toContain('userComment');
    expect(policy.cards!.text).toEqual(expect.arrayContaining(['front', 'back']));
    expect(policy.knowledgePoints!.text).toEqual(
      expect.arrayContaining(['shortOneLiner', 'examPearl', 'misconception', 'claims']),
    );
    // organisation records: what a person typed or built is kept on both sides when it conflicts;
    // what a relation connects never changes
    expect(policy.filingRules!.text).toEqual(expect.arrayContaining(['name', 'match', 'action']));
    expect(policy.syllabi!.text).toEqual(expect.arrayContaining(['name', 'nodes']));
    expect(policy.relations!.text).toContain('note');
    expect(policy.relations!.immutable).toEqual(
      expect.arrayContaining(['fromKind', 'fromId', 'toKind', 'toId', 'type']),
    );
  });

  it('the one-step undo of a re-recognition never leaves the device', () => {
    const active = activeSyncPolicy();
    expect(active.policy.ocrPages!.local).toContain('previousReading');
    const spec = active.tables.find((t) => t.name === 'ocrPages')!;
    expect(spec.derivedFields).toContain('previousReading');
    const wire = serializeRow(spec, {
      documentId: 'd'.repeat(64),
      pageNumber: 1,
      text: 'the cat sat',
      previousReading: { text: 'tbe cat sat', replacedAt: '2026-01-01T00:00:00.000Z' },
    });
    expect(wire.fields).toMatchObject({ text: 'the cat sat' });
    expect(wire.fields).not.toHaveProperty('previousReading');
  });

  it('every table that is registered but not in the policy is deliberately local or unsynchronised', () => {
    const covered = new Set(activeSyncPolicy().tables.map((t) => t.name));
    const leftOut = tableRegistry.tables
      .map((t) => t.name)
      .filter((n) => !covered.has(n))
      .sort();
    // device-local bookkeeping and cached bytes, plus AI output (evidence links are not final), and
    // the game events every device derives from the synced source rows itself (ADR-022)
    expect(leftOut).toEqual(['aiResults', 'attachments', 'gameEvents', 'meta', 'syncOps']);
    expect(unregisteredTables()).toEqual(expect.not.arrayContaining(['cards', 'decks']));
  });
});

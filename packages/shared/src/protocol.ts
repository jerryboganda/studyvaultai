import { z } from 'zod';
import {
  MAX_BANK_NAME_CHARS,
  MAX_COMMENT_CHARS,
  MAX_HEADING_CHARS,
  MAX_QUOTE_CHARS,
} from './constants';
import {
  AnchorSet,
  Bank,
  CaptureMethod,
  ColorId,
  HighlightKind,
  HighlightView,
  HttpUrl,
  Id,
  PageInfo,
  Priority,
  ResolveStatus,
} from './schema';

/**
 * Typed message protocol (ARCHITECTURE: schema-validated, least-authority RPC).
 * Two directions, each a map of `type -> { payload, response }` Zod schemas:
 *   BackgroundRpc: content script / extension pages  -> service worker
 *   TabRpc:        service worker / extension pages  -> content script in one tab
 * Every payload and response is validated at the receiving boundary.
 */

export const ErrorCode = z.enum([
  'invalid_request',
  'forbidden',
  'not_found',
  'storage_unavailable',
  'quota_exceeded',
  'unsupported_page',
  /** Transport failure: nobody answered (no content script in the tab, worker could not start). */
  'no_receiver',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export class StudyVaultError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StudyVaultError';
  }
}

export const Envelope = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ code: ErrorCode, message: z.string() }) }),
]);
export type Envelope = z.infer<typeof Envelope>;

/** Wire format of every request. `v` lets receivers reject messages from an incompatible build. */
export const WireMessage = z.object({ v: z.literal(1), type: z.string(), payload: z.unknown() });

const def = <P extends z.ZodType, R extends z.ZodType>(payload: P, response: R) => ({
  payload,
  response,
});

export const BankLite = Bank.pick({ id: true, name: true, color: true, isInbox: true });
export type BankLite = z.infer<typeof BankLite>;

export const CaptureInput = z.object({
  page: PageInfo,
  exactQuote: z.string().min(1).max(MAX_QUOTE_CHARS),
  anchorSet: AnchorSet,
  headingContext: z.string().max(MAX_HEADING_CHARS).nullable(),
  kind: HighlightKind,
  color: ColorId,
  /** Null means "use the last-used bank, else the Inbox". */
  bankId: Id.nullable(),
  userComment: z.string().max(MAX_COMMENT_CHARS),
  priority: Priority,
  captureMethod: CaptureMethod,
});
export type CaptureInput = z.infer<typeof CaptureInput>;

export const CaptureResult = z.object({
  /** created: new highlight. duplicate: same quote+place already saved. restored: it had been deleted. */
  status: z.enum(['created', 'duplicate', 'restored']),
  highlight: HighlightView,
  bank: BankLite,
  /** For duplicate/restored: true when a new bank membership was added. */
  addedToBank: z.boolean(),
});
export type CaptureResult = z.infer<typeof CaptureResult>;

export const ResolutionReport = z.object({
  id: Id,
  status: ResolveStatus,
  confidence: z.number().min(0).max(1).nullable(),
});

export const HighlightPatch = z
  .object({
    kind: HighlightKind,
    color: ColorId,
    userComment: z.string().max(MAX_COMMENT_CHARS),
    priority: Priority,
  })
  .partial()
  .strict();
export type HighlightPatch = z.infer<typeof HighlightPatch>;

export const SiteStatus = z.object({
  /** http(s) page that is not blocked by scheme. False for chrome://, file://, the Web Store, etc. */
  supported: z.boolean(),
  denied: z.boolean(),
  /** Origin match pattern ("https://example.com/*"), null when unsupported. */
  pattern: z.string().nullable(),
  /** persistent: host permission granted + script registered; none: not granted (activeTab may still apply). */
  access: z.enum(['persistent', 'none']),
  /** A StudyVault content script is currently answering in this tab. */
  active: z.boolean(),
});
export type SiteStatus = z.infer<typeof SiteStatus>;

export const BackgroundRpc = {
  /** Atomically persist source + highlight + bank membership. Handles duplicates and undeleted quotes. */
  'capture.save': def(CaptureInput, CaptureResult),
  'page.highlights': def(
    z.object({ url: HttpUrl, canonicalUrl: HttpUrl.nullable() }),
    z.object({ sourceId: Id.nullable(), highlights: z.array(HighlightView) }),
  ),
  /** From a content script, only highlights of the sender's own page may be changed. */
  'highlight.update': def(z.object({ id: Id, patch: HighlightPatch }), HighlightView),
  /** Soft delete (recoverable). */
  'highlight.delete': def(z.object({ id: Id }), z.object({ id: Id })),
  'highlight.restore': def(z.object({ id: Id }), HighlightView),
  'highlight.reportResolution': def(
    z.object({ items: z.array(ResolutionReport).max(500) }),
    z.object({ updated: z.number().int().min(0) }),
  ),
  'banks.list': def(
    z.object({}),
    z.object({ banks: z.array(BankLite), lastBankId: Id.nullable() }),
  ),
  'bank.create': def(
    z.object({ name: z.string().trim().min(1).max(MAX_BANK_NAME_CHARS) }),
    BankLite,
  ),
  /** Site access state for a tab. `url` comes from the caller (activeTab-visible); tabId is for the ping. */
  'site.status': def(
    z.object({ tabId: z.number().int().min(0), url: z.string().max(2048) }),
    SiteStatus,
  ),
  /**
   * Re-register the persistent content script from settings.persistentOrigins ∩ granted host
   * permissions, minus the deny list. Call after any permission or deny-list change.
   */
  'site.sync': def(z.object({}), z.object({ registeredMatches: z.array(z.string()) })),
  /** Inject the content script into the tab now (needs activeTab or host permission). */
  'tab.activate': def(
    z.object({ tabId: z.number().int().min(0) }),
    z.object({ ok: z.literal(true) }),
  ),
} as const;
export type BackgroundRpc = typeof BackgroundRpc;

export const PageStatus = z.object({
  url: HttpUrl,
  canonicalUrl: HttpUrl.nullable(),
  title: z.string(),
  counts: z.object({
    total: z.number().int().min(0),
    resolved: z.number().int().min(0),
    changed: z.number().int().min(0),
    ambiguous: z.number().int().min(0),
    orphaned: z.number().int().min(0),
    pending: z.number().int().min(0),
  }),
  paintingSupported: z.boolean(),
  hasSelection: z.boolean(),
  blocked: z.enum(['denied-site', 'toolbar-disabled']).nullable(),
});
export type PageStatus = z.infer<typeof PageStatus>;

export const CaptureSelectionResult = z.union([
  CaptureResult,
  z.object({ status: z.literal('no-selection') }),
  z.object({ status: z.literal('blocked'), reason: z.string() }),
]);
export type CaptureSelectionResult = z.infer<typeof CaptureSelectionResult>;

export const TabRpc = {
  'content.ping': def(z.object({}), z.object({ ready: z.literal(true), version: z.string() })),
  'content.pageStatus': def(z.object({}), PageStatus),
  /** Keyboard shortcut / context menu: capture the live selection with the given bank (null = last used). */
  'content.captureSelection': def(
    z.object({ method: CaptureMethod, bankId: Id.nullable() }),
    CaptureSelectionResult,
  ),
  /** Storage changed elsewhere (side panel edit): re-fetch and repaint. */
  'content.refresh': def(z.object({}), z.object({ ok: z.literal(true) })),
  /** Scroll to and flash a highlight. found=false when it is not currently resolvable on the page. */
  'content.reveal': def(z.object({ id: Id }), z.object({ found: z.boolean() })),
} as const;
export type TabRpc = typeof TabRpc;

export type RpcPayload<
  M extends Record<string, { payload: z.ZodType }>,
  K extends keyof M,
> = z.input<M[K]['payload']>;
export type RpcResponse<
  M extends Record<string, { response: z.ZodType }>,
  K extends keyof M,
> = z.output<M[K]['response']>;

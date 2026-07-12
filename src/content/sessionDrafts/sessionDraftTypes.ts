import type { ExportDestinationMetadata } from '../../shared/exportDestination';

export const SESSION_DRAFT_SCHEMA_VERSION = 1 as const;
export const SESSION_DRAFT_MAX_ENTRIES = 100;
export const SESSION_DRAFT_MAX_ENVELOPE_BYTES = 512 * 1024;

export interface SessionDraftRetentionPolicy {
  retentionMs: number;
  maxRestorablePages: number | null;
  maxItemsPerPage: number | null;
}

export interface VideoScreenshotCacheStoragePolicy {
  ttlMs: number;
  maxGlobalEntries: number;
  maxPageEntries: number;
  maxContentBytes: number;
}

export interface SessionDraftStoragePolicy {
  retentionPolicy: SessionDraftRetentionPolicy;
  maxDraftEntries: number;
  maxEnvelopeBytes: number;
  videoScreenshotCache: VideoScreenshotCacheStoragePolicy;
}

export interface SessionDraftStoragePolicyOptions {
  retentionPolicy?: Partial<SessionDraftRetentionPolicy> | null;
  maxDraftEntries?: number;
  maxEnvelopeBytes?: number;
  videoScreenshotCache?: Partial<VideoScreenshotCacheStoragePolicy> | null;
}

export type SessionDraftMode = 'reader' | 'video';
export type SessionDraftActiveStatus = 'active' | 'restorable';
export type SessionDraftTerminalStatus = 'discarded' | 'exported';
export type SessionDraftStatus = SessionDraftActiveStatus | SessionDraftTerminalStatus;
export type SessionCommentDraftSnapshot = Record<string, string>;

export function isRestorableSessionDraftStatus(status: SessionDraftStatus): boolean {
  return status === 'active' || status === 'restorable';
}

export interface SessionDraftOwnerContext {
  tabId?: number;
  windowId?: number;
  frameId?: number;
}

export interface SessionDraftPayloadBase {
  commentDrafts?: SessionCommentDraftSnapshot;
  ownerContext?: SessionDraftOwnerContext;
  [key: string]: unknown;
}

export interface ReaderSessionDraftHighlightPayload {
  id: string;
  selectedHtml: string;
  selectedText: string;
  comment: string;
  fragmentUrl: string;
  createdAt: number;
}

export interface ReaderSessionDraftPayload extends SessionDraftPayloadBase {
  mode?: 'reader';
  url?: string;
  title?: string;
  destination?: ExportDestinationMetadata;
  highlights?: ReaderSessionDraftHighlightPayload[];
}

export interface VideoSessionDraftPayload extends SessionDraftPayloadBase {}

interface SessionDraftEnvelopeBase<
  TMode extends SessionDraftMode,
  TPayload extends SessionDraftPayloadBase
> {
  schemaVersion: typeof SESSION_DRAFT_SCHEMA_VERSION;
  draftId: string;
  mode: TMode;
  pageKey: string;
  pageUrl: string;
  pageTitle: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  status: SessionDraftStatus;
  payload: TPayload;
}

export type ReaderSessionDraftEnvelope = SessionDraftEnvelopeBase<
  'reader',
  ReaderSessionDraftPayload
>;

export type VideoSessionDraftEnvelope = SessionDraftEnvelopeBase<'video', VideoSessionDraftPayload>;

export type SessionDraftEnvelope = ReaderSessionDraftEnvelope | VideoSessionDraftEnvelope;

export interface SessionDraftIndexEntry {
  key: string;
  draftId: string;
  mode: SessionDraftMode;
  pageKey: string;
  updatedAt: number;
  expiresAt: number;
  status: SessionDraftStatus;
  ownerContext?: SessionDraftOwnerContext;
}

export interface SessionDraftIndex {
  schemaVersion: typeof SESSION_DRAFT_SCHEMA_VERSION;
  entries: SessionDraftIndexEntry[];
}

export interface SessionDraftRepositoryOptions {
  storagePolicy?: SessionDraftStoragePolicy | undefined;
  ttlMs?: number;
  retentionPolicy?: SessionDraftRetentionPolicy | undefined;
  maxEntries?: number;
  maxEnvelopeBytes?: number;
  resolveOwnerContext?: () => MaybePromise<SessionDraftOwnerContext | null | undefined>;
  isOwnerContextActive?: (ownerContext: SessionDraftOwnerContext) => MaybePromise<boolean>;
  deleteKeys?: (
    keys: readonly string[],
    cause: 'repair' | 'save-retention' | 'remove' | 'prune'
  ) => Promise<void>;
}

export type SessionDraftRemovalTarget = string | { key: string };

export interface SessionDraftSelectionOptions {
  ownerContext?: SessionDraftOwnerContext | null;
}

export interface SessionDraftSaveOptions {
  ownerContext?: SessionDraftOwnerContext | null;
}

export interface SessionDraftRepository {
  loadLatest(
    mode: SessionDraftMode,
    pageUrl: string,
    now?: number,
    options?: SessionDraftSelectionOptions
  ): Promise<SessionDraftEnvelope | null>;
  save(envelope: SessionDraftEnvelope, options?: SessionDraftSaveOptions): Promise<void>;
  remove(target: SessionDraftRemovalTarget): Promise<void>;
  listCandidates(
    mode: SessionDraftMode,
    pageUrl: string,
    now?: number,
    options?: SessionDraftSelectionOptions
  ): Promise<SessionDraftEnvelope[]>;
  pruneExpired(now?: number): Promise<void>;
}

type MaybePromise<T> = T | Promise<T>;

export interface SessionDraftPersisterOptions<
  TEnvelope extends SessionDraftEnvelope = SessionDraftEnvelope
> {
  repository: Pick<SessionDraftRepository, 'save'>;
  buildEnvelope: () => MaybePromise<TEnvelope | null>;
  delayMs?: number;
}

export interface SessionDraftPersister {
  scheduleSave(): Promise<void>;
  cancelPending(): void;
  flushNow(): Promise<void>;
  dispose(options?: { flush?: boolean }): Promise<void>;
}

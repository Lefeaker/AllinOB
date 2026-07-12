import type { ExportDestinationMetadata } from '@shared/exportDestination';
import type { StorageAreaService } from '@platform/interfaces/storage';
import type { ReaderHighlightRecord } from './services/highlightManager';
import {
  buildReaderSessionDraftEnvelope,
  createReaderSessionDraftId,
  loadLatestReaderSessionDraftResult,
  type LoadedReaderSessionDraft,
  type LoadedReaderSessionDraftResult
} from './sessionDrafts';
import {
  createSessionDraftPersister,
  createSessionDraftStorageKey,
  type ReaderSessionDraftEnvelope,
  type SessionCommentDraftSnapshot,
  type SessionDraftPersister,
  type SessionDraftRepository,
  type SessionDraftStatus,
  type SessionDraftStoragePolicy,
  type SessionDraftTerminalStatus
} from '../sessionDrafts';
import { finalizeReaderSessionTerminalDraft } from './readerSessionDraftTerminalFinalizer';

export interface ReaderSessionDraftControllerOptions {
  doc: Document;
  pageUrl: string;
  storageArea: StorageAreaService;
  repository: SessionDraftRepository;
  sessionDraftStoragePolicy?: SessionDraftStoragePolicy;
  getPageTitle: () => string;
  getHighlights: () => ReaderHighlightRecord[];
  getCommentDrafts: () => SessionCommentDraftSnapshot;
  getDestinationMetadata: () => ExportDestinationMetadata | undefined;
  onPersistenceFailure: () => void;
}

export interface ReaderSessionDraftIdentity {
  draftId: string | null;
  draftCreatedAt: number | null;
  draftStorageKey: string | null;
}

export class ReaderSessionDraftController {
  private readonly repository: SessionDraftRepository;
  private readonly persister: SessionDraftPersister;
  private draftId: string | null = null;
  private draftCreatedAt: number | null = null;
  private draftStorageKey: string | null = null;
  private removeLifecycleListeners: (() => void) | null = null;

  constructor(private readonly options: ReaderSessionDraftControllerOptions) {
    this.repository = this.options.repository;
    this.persister = createSessionDraftPersister({
      repository: this.repository,
      buildEnvelope: () => this.buildEnvelope('active')
    });
  }

  get identity(): ReaderSessionDraftIdentity {
    return {
      draftId: this.draftId,
      draftCreatedAt: this.draftCreatedAt,
      draftStorageKey: this.draftStorageKey
    };
  }

  loadLatestResult(): Promise<LoadedReaderSessionDraftResult> {
    return loadLatestReaderSessionDraftResult(
      this.repository,
      this.options.storageArea,
      this.options.pageUrl
    );
  }

  claimLoadedDraft(draft: LoadedReaderSessionDraft): void {
    this.draftId = draft.envelope.draftId;
    this.draftCreatedAt = draft.envelope.createdAt;
    this.draftStorageKey = draft.storageKey;
  }

  buildEnvelope(status: SessionDraftStatus): ReaderSessionDraftEnvelope | null {
    const now = Date.now();
    const draftId = this.draftId ?? createReaderSessionDraftId(now);
    const createdAt = this.draftCreatedAt ?? now;
    const destination = this.options.getDestinationMetadata();
    const envelope = buildReaderSessionDraftEnvelope({
      draftId,
      createdAt,
      now,
      pageUrl: this.options.pageUrl,
      pageTitle: this.options.getPageTitle(),
      highlights: this.options.getHighlights(),
      commentDrafts: this.options.getCommentDrafts(),
      status,
      ...(this.options.sessionDraftStoragePolicy
        ? { retentionPolicy: this.options.sessionDraftStoragePolicy.retentionPolicy }
        : {}),
      ...(destination ? { destination } : {})
    });

    if (!envelope) {
      return null;
    }

    this.draftId = draftId;
    this.draftCreatedAt = createdAt;
    this.draftStorageKey = createSessionDraftStorageKey({
      mode: envelope.mode,
      pageKey: envelope.pageKey,
      draftId: envelope.draftId
    });
    return envelope;
  }

  async persistMutation(): Promise<void> {
    if (!this.hasPersistableDraftContent()) {
      await this.clearPersistedDraft();
      return;
    }

    await this.persister.scheduleSave();
  }

  queuePersistence(): void {
    void this.persistMutation().catch((error) => {
      console.warn('[ReaderSession] Failed to persist session draft:', error);
    });
  }

  autosaveCommentDraftMutation(): void {
    void this.persistMutation().catch((error) => {
      console.warn('[ReaderSession] Failed to persist session draft:', error);
      this.options.onPersistenceFailure();
    });
  }

  async finalizeTerminalDraft(status: SessionDraftTerminalStatus): Promise<boolean> {
    return finalizeReaderSessionTerminalDraft({
      status,
      currentDraftStorageKey: this.draftStorageKey,
      repository: this.repository,
      persister: this.persister,
      storageArea: this.options.storageArea,
      buildCurrentEnvelope: (nextStatus) => this.buildEnvelope(nextStatus),
      applyTerminalIdentity: ({ draftId, draftCreatedAt, draftStorageKey }) => {
        this.draftId = draftId;
        this.draftCreatedAt = draftCreatedAt;
        this.draftStorageKey = draftStorageKey;
      }
    });
  }

  async clearPersistedDraft(): Promise<void> {
    if (!this.draftStorageKey) {
      return;
    }

    const draftStorageKey = this.draftStorageKey;
    await this.repository.remove({ key: draftStorageKey });
    if (this.draftStorageKey === draftStorageKey) {
      this.clearIdentity();
    }
  }

  async discardStoredDraftCandidate(storageKey: string): Promise<void> {
    try {
      await this.repository.remove({ key: storageKey });
    } catch (error) {
      console.warn('[ReaderSession] Failed to discard invalid stored session draft:', error);
    }
    if (this.draftStorageKey === storageKey) {
      this.clearIdentity();
    }
  }

  bindLifecycleListeners(): void {
    if (this.removeLifecycleListeners) {
      return;
    }

    const onPageHide = () => {
      void this.flushForRestore();
    };
    const onBeforeUnload = () => {
      void this.flushForRestore();
    };
    this.options.doc.defaultView?.addEventListener('pagehide', onPageHide, { passive: true });
    this.options.doc.defaultView?.addEventListener('beforeunload', onBeforeUnload);
    this.removeLifecycleListeners = () => {
      this.options.doc.defaultView?.removeEventListener('pagehide', onPageHide);
      this.options.doc.defaultView?.removeEventListener('beforeunload', onBeforeUnload);
      this.removeLifecycleListeners = null;
    };
  }

  async flushForRestore(): Promise<void> {
    try {
      const envelope = this.buildEnvelope('restorable');
      this.persister.cancelPending();
      if (!envelope) {
        await this.clearPersistedDraft();
        return;
      }
      await this.repository.save(envelope);
    } catch (error) {
      console.warn('[ReaderSession] Failed to flush restorable session draft:', error);
    }
  }

  async dispose(): Promise<void> {
    this.removeLifecycleListeners?.();
    try {
      await this.persister.dispose();
    } catch (error) {
      console.warn('[ReaderSession] Failed to dispose session draft persister:', error);
    }
  }

  private hasPersistableDraftContent(): boolean {
    return (
      this.options.getHighlights().length > 0 ||
      Object.keys(this.options.getCommentDrafts()).length > 0
    );
  }

  private clearIdentity(): void {
    this.draftId = null;
    this.draftCreatedAt = null;
    this.draftStorageKey = null;
  }
}

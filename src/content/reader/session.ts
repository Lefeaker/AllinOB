import type { ClipPromptGateway } from '../clipper/application/clipPromptGateway';
import { DEFAULT_FRAGMENT_CONFIG } from '../clipper/services/fragmentConfig';
import { handleReaderKeydown, isNodeInsideReaderUi } from './sessionDom';
import { ReaderSessionState, resolveReadingConfig } from './sessionState';
import type { ExternalHighlightPayload, ReaderBootstrapHighlight } from './types';
import type { ReaderSelectionPayload } from './services/selectionController';
import type { ReaderHighlightManager, ReaderHighlightRecord } from './services/highlightManager';
import type { ReaderPanelCoordinator } from './panelCoordinator';
import type { ReaderSelectionController } from './services/selectionController';
import type { ReaderEnvironmentController } from './environmentController';
import type { ReaderSessionLifecycle } from './sessionLifecycle';
import type { ReadingSessionOptions } from '../../shared/types/options';
import { bucketCount, createFeatureTimer } from '../../shared/analytics/featureTimer';
import {
  clearReaderSession,
  isReaderSessionActive,
  registerReaderSession
} from '../runtime/contentSessionRegistry';
import { clearHighlightThemeState } from '../shared/highlightThemeState';
import { ContentExportDestinationState } from '../shared/exportDestinationState';
import type { ClipPayload } from '../../shared/types';
import type { ReaderSessionDependencies as FullReaderSessionDependencies } from './sessionTypes';
import {
  createSessionMutationRunner,
  type SessionDraftTerminalStatus,
  type SessionMutationTransaction
} from '../sessionDrafts';
import {
  applyReaderHighlightFromRange,
  cancelReaderSession,
  finishReaderSession,
  focusReaderHighlight,
  handleReaderSessionMouseUp,
  handleReaderSessionSelection,
  ingestExternalReaderHighlight,
  removeReaderHighlight,
  submitReaderHighlightEdit,
  trackReaderUsageEvent
} from './sessionOperations';
import { restoreReaderSessionDraftHighlights } from './sessionDrafts';
import { ReaderSessionDraftController } from './readerSessionDraftController';

const ADD_HIGHLIGHT_EVENT = 'aiob-reader:add-highlight';

export type { ReaderSessionDependencies } from './sessionTypes';

export class ReaderSession {
  private readonly state = new ReaderSessionState();
  private readonly highlightManager: ReaderHighlightManager;
  private readonly panelCoordinator: ReaderPanelCoordinator;
  private readonly selectionController: ReaderSelectionController;
  private readonly environment: ReaderEnvironmentController;
  private readonly lifecycle: ReaderSessionLifecycle;
  private readonly destinationState: ContentExportDestinationState;
  private readonly draftController: ReaderSessionDraftController;
  private readonly draftMutationRunner = createSessionMutationRunner();
  private pendingDraftMutations = 0;

  private get draftId(): string | null {
    return this.draftController.identity.draftId;
  }

  private get draftCreatedAt(): number | null {
    return this.draftController.identity.draftCreatedAt;
  }

  private get draftStorageKey(): string | null {
    return this.draftController.identity.draftStorageKey;
  }

  private get operationContext() {
    return {
      session: this,
      doc: this.doc,
      url: this.url,
      clipPrompt: this.clipPrompt,
      state: this.state,
      highlightManager: this.highlightManager,
      panelCoordinator: this.panelCoordinator,
      lifecycle: this.lifecycle,
      dependencies: this.dependencies,
      getExportDestinationMetadata: () => this.destinationState.metadata,
      persistDraftMutation: () => this.persistDraftMutation(),
      disposeDraftPersistence: () => this.disposeDraftPersistence(),
      clearPersistedDraft: () => this.clearPersistedDraft(),
      finalizeTerminalDraft: (status: SessionDraftTerminalStatus) =>
        this.finalizeTerminalDraft(status),
      runDraftMutation: <Result>(transaction: SessionMutationTransaction<Result, void>) =>
        this.runDraftMutation(transaction)
    };
  }

  constructor(
    private readonly doc: Document,
    private readonly url: string,
    private readonly clipPrompt: ClipPromptGateway,
    private readonly dependencies: FullReaderSessionDependencies
  ) {
    this.highlightManager = this.dependencies.createHighlightManager(this.doc);
    this.panelCoordinator = this.dependencies.createPanelCoordinator({
      viewFactory: this.dependencies.viewFactory,
      callbacks: {
        onFinish: () => this.finish(),
        onCancel: () => this.cancel(),
        onSelectDestination: (id) => this.selectDestination(id),
        onDeleteHighlight: (id) => this.removeHighlightById(id),
        onSubmitHighlightEdit: (id, comment) => this.submitHighlightEdit(id, comment),
        onFocusHighlight: (id) => this.focusHighlight(id)
      },
      reconstructText: (highlight) => this.highlightManager.reconstructText(highlight),
      onCommentDraftChange: () => this.autosaveCommentDraftMutation()
    });
    this.selectionController = this.dependencies.createSelectionController({
      doc: this.doc,
      fragmentConfig: DEFAULT_FRAGMENT_CONFIG,
      canHandleSelection: () =>
        !this.state.handlingSelection && !this.state.exporting && !this.state.saving,
      isNodeInsideUi: (node) =>
        isNodeInsideReaderUi(node, this.panelCoordinator.getElement(), this.doc),
      onSelectionReady: (payload) => {
        void this.handleSelection(payload);
      }
    });
    this.environment = this.dependencies.createEnvironmentController(
      {
        doc: this.doc,
        storage: this.dependencies.storage,
        optionsRepository: this.dependencies.optionsRepository
      },
      {
        onMessagesUpdate: (messages) => {
          this.state.messages = messages;
          this.panelCoordinator.updateMessages(messages, this.state.highlights);
        },
        onFragmentConfigUpdate: (config) => {
          this.selectionController.updateFragmentConfig(config);
        }
      }
    );
    this.lifecycle = this.dependencies.createLifecycle(
      {
        doc: this.doc,
        selectionController: this.selectionController,
        panelCoordinator: this.panelCoordinator,
        environment: this.environment,
        externalHighlightEvent: ADD_HIGHLIGHT_EVENT
      },
      {
        onSelection: (_payload) => {
          // Selection flow is already owned by the selection controller wiring.
        },
        onExternalHighlight: (payload) => this.ingestExternalHighlightPayload(payload),
        onKeydown: (event) => {
          handleReaderKeydown(event, {
            isPanelEditing: () => this.panelCoordinator.isEditing(),
            onCancel: () => this.cancel(),
            onFinish: () => this.finish()
          });
        }
      }
    );
    this.destinationState = new ContentExportDestinationState(
      this.dependencies.optionsRepository,
      () => this.createDestinationPayload(),
      this.dependencies.optionsPageUrl
    );
    this.draftController = new ReaderSessionDraftController({
      doc: this.doc,
      pageUrl: this.url,
      storageArea: this.dependencies.storage.local,
      getPageTitle: () => this.getDraftPageTitle(),
      getHighlights: () => this.state.highlights,
      getCommentDrafts: () => this.panelCoordinator.snapshotCommentDrafts(),
      getDestinationMetadata: () => this.destinationState.metadata,
      onPersistenceFailure: () =>
        this.panelCoordinator.applyHint('failure', this.state.highlights.length),
      ...(this.dependencies.sessionDraftStoragePolicy
        ? { sessionDraftStoragePolicy: this.dependencies.sessionDraftStoragePolicy }
        : {})
    });
  }

  async initialize(
    initialHighlights?: ReaderBootstrapHighlight | ReaderBootstrapHighlight[]
  ): Promise<void> {
    await this.start(initialHighlights);
  }

  destroy(): void {
    this.cancel();
  }

  __setTestHighlights(
    records: Array<{
      id: string;
      selectedHtml: string;
      selectedText: string;
      comment: string;
      fragmentUrl: string;
      wrapper: HTMLElement;
    }>
  ): void {
    this.state.highlights = records.map((record) => ({
      id: record.id,
      selectedHtml: record.selectedHtml,
      selectedText: record.selectedText,
      comment: record.comment,
      fragmentUrl: record.fragmentUrl,
      wrapper: record.wrapper,
      wrapperSegments: [record.wrapper],
      createdAt: Date.now()
    }));
    this.syncHighlightsUi();
  }

  get __testHighlights(): Array<{
    id: string;
    selectedHtml: string;
    selectedText: string;
    comment: string;
    fragmentUrl: string;
    wrapper: HTMLElement;
  }> {
    return this.state.highlights;
  }

  async start(
    initialHighlights?: ReaderBootstrapHighlight | ReaderBootstrapHighlight[]
  ): Promise<void> {
    if (isReaderSessionActive(this.doc)) {
      return;
    }

    registerReaderSession(this, this.doc);

    try {
      await this.lifecycle.start();
      this.draftController.bindLifecycleListeners();
      this.state.analyticsTimer = createFeatureTimer();
      this.state.analyticsSource = 'unknown';
      this.applyInitialDestination(initialHighlights);
      const loadedDraft = await this.hydrateStoredDraft();
      await this.refreshDestinationPreview();
      this.applyReadingConfig(await this.loadReadingConfig());
      this.watchReadingConfig();
      void trackReaderUsageEvent(this.operationContext, 'reader_session_started', {
        source: this.state.analyticsSource
      });
      const bootstrappedHighlights = this.bootstrapHighlights(initialHighlights);
      this.panelCoordinator.refreshHint(this.state.highlights.length);
      if (loadedDraft || bootstrappedHighlights > 0) {
        this.queueDraftPersistence();
      }
    } catch (error) {
      this.state.analyticsTimer = null;
      await this.disposeDraftPersistence();
      clearReaderSession(this, this.doc);
      throw error;
    }
  }

  private bootstrapHighlights(
    initialHighlights?: ReaderBootstrapHighlight | ReaderBootstrapHighlight[]
  ): number {
    const bootHighlights = initialHighlights
      ? Array.isArray(initialHighlights)
        ? initialHighlights
        : [initialHighlights]
      : [];

    for (const highlight of bootHighlights) {
      try {
        applyReaderHighlightFromRange(
          this.operationContext,
          highlight.range,
          highlight.selectedHtml,
          highlight.selectedText,
          highlight.comment
        );
      } catch (error) {
        console.error('[ReaderSession] Failed to add initial highlight:', error);
      }
    }
    return bootHighlights.length;
  }

  private applyInitialDestination(
    initialHighlights?: ReaderBootstrapHighlight | ReaderBootstrapHighlight[]
  ): void {
    const bootHighlights = initialHighlights
      ? Array.isArray(initialHighlights)
        ? initialHighlights
        : [initialHighlights]
      : [];
    const initialDestination = bootHighlights.find(
      (highlight) => highlight.destination
    )?.destination;
    this.destinationState.applyMetadata(initialDestination);
  }

  private async hydrateStoredDraft(): Promise<boolean> {
    const restoreDurationBucket = this.state.analyticsTimer?.durationBucket() ?? 'under_100ms';
    try {
      const loadedDraftResult = await this.draftController.loadLatestResult();
      if (loadedDraftResult.status === 'none') {
        return false;
      }
      if (loadedDraftResult.status === 'invalid_removed') {
        void trackReaderUsageEvent(this.operationContext, 'reader_draft_restored', {
          highlight_count_bucket: bucketCount(loadedDraftResult.highlightCount),
          outcome: 'failed',
          duration_bucket: restoreDurationBucket
        });
        return false;
      }

      const loadedDraft = loadedDraftResult.draft;
      try {
        const restored = restoreReaderSessionDraftHighlights({
          doc: this.doc,
          highlightManager: this.highlightManager,
          highlights: loadedDraft.payload.highlights
        });

        this.draftController.claimLoadedDraft(loadedDraft);
        this.destinationState.applyMetadata(loadedDraft.payload.destination);
        this.panelCoordinator.hydrateCommentDrafts(loadedDraft.payload.commentDrafts);
        this.state.highlights = restored.highlights;
        this.syncHighlightsUi();
        void trackReaderUsageEvent(this.operationContext, 'reader_draft_restored', {
          highlight_count_bucket: bucketCount(loadedDraftResult.highlightCount),
          outcome: 'completed',
          detached_highlight_count_bucket: bucketCount(restored.detachedHighlightIds.length),
          duration_bucket: restoreDurationBucket
        });
        return true;
      } catch (error) {
        await this.discardStoredDraftCandidate(loadedDraft.storageKey);
        console.warn('[ReaderSession] Failed to hydrate stored session draft:', error);
        void trackReaderUsageEvent(this.operationContext, 'reader_draft_restored', {
          highlight_count_bucket: bucketCount(loadedDraftResult.highlightCount),
          outcome: 'failed',
          duration_bucket: restoreDurationBucket
        });
        return false;
      }
    } catch (error) {
      console.warn('[ReaderSession] Failed to hydrate stored session draft:', error);
      return false;
    }
  }

  private async loadReadingConfig(): Promise<ReadingSessionOptions> {
    try {
      return resolveReadingConfig(await this.dependencies.readerRepository.getReadingConfig());
    } catch (error) {
      console.warn('[ReaderSession] Failed to load reading config, using defaults:', error);
      return resolveReadingConfig();
    }
  }

  private watchReadingConfig(): void {
    this.state.stopReadingConfigWatcher?.();
    this.state.stopReadingConfigWatcher = this.dependencies.readerRepository.onConfigChange(
      (config) => {
        this.applyReadingConfig(resolveReadingConfig(config));
      }
    );
  }

  private applyReadingConfig(config: ReturnType<typeof resolveReadingConfig>): void {
    this.state.readingConfig = config;
    this.highlightManager.applyTheme(config.highlightTheme);
  }

  private async handleSelection(payload: ReaderSelectionPayload): Promise<void> {
    await handleReaderSessionSelection(this.operationContext, payload);
  }

  private async handleMouseUp(event: MouseEvent): Promise<void> {
    await handleReaderSessionMouseUp(this.operationContext, event);
  }

  ingestExternalHighlight(
    range: Range,
    selectedHtml: string,
    selectedText: string,
    comment: string
  ): void {
    this.ingestExternalHighlightPayload({ range, selectedHtml, selectedText, comment });
  }

  private ingestExternalHighlightPayload(payload: ExternalHighlightPayload): void {
    void ingestExternalReaderHighlight(this.operationContext, payload);
  }

  private syncHighlightsUi(): void {
    this.highlightManager.sortByDocumentOrder(this.state.highlights);
    this.panelCoordinator.updateHighlights(this.state.highlights);
  }

  private async finish(): Promise<void> {
    await finishReaderSession(
      this.operationContext,
      () => this.loadReadingConfig(),
      (config) => this.applyReadingConfig(config)
    );
  }

  private async refreshDestinationPreview(): Promise<void> {
    const preview = await this.destinationState.refresh();
    this.panelCoordinator.updateDestination(preview);
  }

  private async selectDestination(id: string): Promise<void> {
    const previousMetadata = this.destinationState.metadata;
    const previousPreview = this.destinationState.currentPreview;

    await this.runDraftMutation({
      apply: () => {
        this.destinationState.select(id);
        return { previousMetadata, previousPreview };
      },
      save: async () => {
        await this.refreshDestinationPreview();
        await this.persistDraftMutation();
      },
      rollback: async ({ previousMetadata, previousPreview }) => {
        this.destinationState.applyMetadata(previousMetadata);
        if (previousMetadata) {
          await this.refreshDestinationPreview();
        } else {
          this.panelCoordinator.updateDestination(previousPreview);
        }
        this.panelCoordinator.applyHint('failure', this.state.highlights.length);
      },
      onSaveError: (error) => {
        console.warn('[ReaderSession] Failed to save export destination:', error);
      }
    });
  }

  private createDestinationPayload(): ClipPayload {
    const parsedUrl = this.parseCurrentUrl();
    const title = this.doc.title || parsedUrl?.hostname || 'Untitled';
    const domain = parsedUrl?.hostname ?? '';
    const markdown = this.state.highlights
      .map((highlight) => this.highlightManager.reconstructText(highlight))
      .join('\n\n');
    return {
      markdown: markdown || title,
      title,
      type: 'clipper',
      meta: {
        url: this.url,
        sourceUrl: this.url,
        resolvedUrl: this.url,
        ...(domain ? { domain } : {}),
        readerMode: true
      }
    };
  }

  private parseCurrentUrl(): URL | null {
    try {
      return new URL(this.url);
    } catch {
      return null;
    }
  }

  private cancel(): void {
    void cancelReaderSession(this.operationContext);
  }

  private buildDraftEnvelope(status: Parameters<ReaderSessionDraftController['buildEnvelope']>[0]) {
    return this.draftController.buildEnvelope(status);
  }

  private getDraftPageTitle(): string {
    return this.doc.title || this.parseCurrentUrl()?.hostname || 'Untitled';
  }

  private async persistDraftMutation(): Promise<void> {
    await this.draftController.persistMutation();
  }

  private queueDraftPersistence(): void {
    this.draftController.queuePersistence();
  }

  private autosaveCommentDraftMutation(): void {
    this.draftController.autosaveCommentDraftMutation();
  }

  private async finalizeTerminalDraft(status: SessionDraftTerminalStatus): Promise<boolean> {
    return this.draftController.finalizeTerminalDraft(status);
  }

  private async runDraftMutation<Result>(
    transaction: SessionMutationTransaction<Result, void>
  ): Promise<boolean> {
    this.pendingDraftMutations += 1;
    this.state.saving = true;

    try {
      return await this.draftMutationRunner.run(transaction);
    } finally {
      this.pendingDraftMutations = Math.max(0, this.pendingDraftMutations - 1);
      this.state.saving = this.pendingDraftMutations > 0;
    }
  }

  private async clearPersistedDraft(): Promise<void> {
    await this.draftController.clearPersistedDraft();
  }

  private async discardStoredDraftCandidate(storageKey: string): Promise<void> {
    await this.draftController.discardStoredDraftCandidate(storageKey);
  }

  private async flushDraftForRestore(): Promise<void> {
    await this.draftController.flushForRestore();
  }

  private async disposeDraftPersistence(): Promise<void> {
    await this.draftController.dispose();
  }

  private cleanup(): void {
    this.lifecycle.cleanup();
    this.state.stopReadingConfigWatcher?.();
    this.state.stopReadingConfigWatcher = null;

    for (const highlight of this.state.highlights) {
      this.highlightManager.unwrapHighlight(highlight);
    }
    this.state.highlights = [];

    clearReaderSession(this, this.doc);
    this.state.exporting = false;
    this.state.handlingSelection = false;
    clearHighlightThemeState(this.doc);

    if (this.state.highlightFocusTimeout !== null) {
      this.doc.defaultView?.clearTimeout(this.state.highlightFocusTimeout);
      this.state.highlightFocusTimeout = null;
    }

    this.doc.defaultView?.getSelection()?.removeAllRanges();
  }

  private focusHighlight(id: string): void {
    focusReaderHighlight(this.operationContext, id);
  }

  private async removeHighlightById(id: string): Promise<void> {
    const saved = await removeReaderHighlight(this.operationContext, id);
    if (!saved) {
      throw new Error('Failed to save reader highlight removal.');
    }
  }

  private async submitHighlightEdit(id: string, nextComment: string): Promise<void> {
    const saved = await submitReaderHighlightEdit(this.operationContext, id, nextComment);
    if (!saved) {
      throw new Error('Failed to save reader highlight edit.');
    }
  }

  private findHighlight(id: string): ReaderHighlightRecord | undefined {
    return this.state.highlights.find((highlight) => highlight.id === id);
  }
}

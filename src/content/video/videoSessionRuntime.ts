import { bucketCount } from '../../shared/analytics';
import type { ReaderHighlightTheme } from '../../shared/types/options';
import type { VideoAddCaptureSource } from './application/videoPanelModel';
import type { VideoFragmentCapture } from './types';
import { FragmentHighlighter, DEFAULT_HIGHLIGHT_THEME } from './fragmentHighlighter';
import { DEFAULT_SESSION_MESSAGES, type VideoSessionMessages } from './sessionMessages';
import { VideoHintManager, type VideoHintState } from './videoHintManager';
import type { VideoSessionAddCaptureOptions, VideoSessionDependencies } from './sessionTypes';
import { VideoSessionState } from './sessionState';
import {
  getVideoDocumentSelection,
  isVideoRangeInsideUi,
  resolveVideoHintState
} from './videoSessionSelection';
import { isVideoSessionActive, registerVideoSession } from '../runtime/contentSessionRegistry';
import {
  applyVideoSessionHighlightTheme,
  beginVideoSessionAnalytics,
  cancelVideoSession,
  cleanupVideoSession,
  finishVideoSession,
  focusVideoSessionCapture,
  handleVideoSessionAddCapture,
  ingestVideoSessionTextCapture,
  loadVideoSessionHighlightTheme
} from './sessionOperations';
import {
  removeVideoSessionCapture,
  submitVideoSessionCaptureEdit,
  toggleVideoSessionCaptureScreenshot
} from './videoSessionCaptureMutations';
import type { VideoCaptureMutationTransaction } from './videoCaptureMutationTypes';
import {
  finalizeVideoSessionStart,
  initializeVideoSessionEnvironment
} from './videoSessionBootstrap';
import { createVideoSessionRuntimeOperationContext } from './videoSessionRuntimeOperationContext';
import {
  ensureVideoSessionCaptureHighlight,
  getVideoSessionFragmentElement,
  syncVideoSessionPanel
} from './videoSessionPanelState';
import {
  handleVideoSessionUrlChange,
  handleVideoSessionVideoElementChange,
  refreshVideoSessionContext
} from './videoSessionContextRefresh';
import { createVideoSessionPlatformContext } from './videoSessionPlatformContext';
import type { PendingSelectionTracker } from './pendingSelectionTracker';
import type { ShadowSelectionBridge } from './shadowSelectionBridge';
import type { FragmentHighlightCoordinator } from './fragmentHighlightCoordinator';
import type { SelectionCaptureController } from './selectionCaptureController';
import type { VideoSessionLifecycle } from './sessionLifecycle';
import type { VideoSessionExporter } from './videoSessionExporter';
import type { VideoFragmentSelectionController } from './videoFragmentSelectionController';
import type { VideoSessionPlatformController } from './sessionPlatformController';
import type { VideoSessionDomController } from './sessionDom';
import type { VideoSessionControllers } from './videoSessionControllers';
import { ContentExportDestinationState } from '../shared/exportDestinationState';
import type { ClipPayload } from '../../shared/types';
import { VideoCommentEditorPlaybackController } from './videoCommentEditorPlaybackController';
import { VideoScreenshotPreparationCoordinator } from './videoScreenshotPreparationCoordinator';
import { applyVideoSessionCommentDrafts } from './videoSessionDraftSync';
import { createVideoSessionDestinationPayload } from './videoSessionDestinationPayload';
import { hasRequestedTimestampScreenshot } from './screenshotIntent';
import type { VideoTimestampCapture } from './types';
import { VideoSessionMutationCoordinator } from './videoSessionMutationCoordinator';
import { emitVideoUsageEvent } from './videoCaptureMutationTransaction';

export class VideoSession {
  private readonly state = new VideoSessionState(DEFAULT_HIGHLIGHT_THEME);
  private messages: VideoSessionMessages = DEFAULT_SESSION_MESSAGES;
  private hintManager!: VideoHintManager;
  private fragmentHighlighter!: FragmentHighlighter;
  private pendingSelection!: PendingSelectionTracker;
  private shadowSelectionBridge!: ShadowSelectionBridge;
  private fragmentHighlightCoordinator!: FragmentHighlightCoordinator;
  private selectionCaptureController!: SelectionCaptureController;
  private fragmentSelectionController!: VideoFragmentSelectionController;
  private lifecycle!: VideoSessionLifecycle;
  private exporter!: VideoSessionExporter;
  private platformController!: VideoSessionPlatformController;
  private dom!: VideoSessionDomController;
  private readonly destinationState: ContentExportDestinationState;
  private readonly commentEditorPlayback: VideoCommentEditorPlaybackController;
  private readonly screenshotPreparation: VideoScreenshotPreparationCoordinator;
  private draftController!: VideoSessionControllers['draftController'];
  private persistPreparedScreenshotCache:
    | VideoSessionControllers['persistPreparedScreenshot']
    | null = null;
  private readonly mutationCoordinator: VideoSessionMutationCoordinator;
  private controllersReadyPromise: Promise<void> | null = null;
  private isCleaningUp = false;

  private get operationContext() {
    return createVideoSessionRuntimeOperationContext({
      session: this,
      doc: this.doc,
      state: this.state,
      dependencies: this.dependencies,
      dom: this.dom,
      exporter: this.exporter,
      fragmentHighlighter: this.fragmentHighlighter,
      fragmentHighlightCoordinator: this.fragmentHighlightCoordinator,
      shadowSelectionBridge: this.shadowSelectionBridge,
      pendingSelection: this.pendingSelection,
      selectionCaptureController: this.selectionCaptureController,
      fragmentSelectionController: this.fragmentSelectionController,
      lifecycle: this.lifecycle,
      platformController: this.platformController,
      hintManager: this.hintManager,
      messages: this.messages,
      destinationState: this.destinationState,
      commentEditorPlayback: this.commentEditorPlayback,
      screenshotPreparation: this.screenshotPreparation,
      applyHint: (state: VideoHintState) => this.applyHint(state),
      syncPanel: () => this.syncPanel(),
      runCaptureMutation: <Result>(transaction: VideoCaptureMutationTransaction<Result>) =>
        this.mutationCoordinator.runCaptureMutation(transaction),
      ensureCaptureHighlight: (capture: VideoFragmentCapture) =>
        this.ensureCaptureHighlight(capture),
      drafts: this.draftController
    });
  }

  constructor(
    private readonly doc: Document,
    private readonly dependencies: VideoSessionDependencies
  ) {
    this.destinationState = new ContentExportDestinationState(
      this.dependencies.optionsRepository,
      () => this.createDestinationPayload(),
      this.dependencies.optionsPageUrl
    );
    this.mutationCoordinator = new VideoSessionMutationCoordinator(this.state);
    this.commentEditorPlayback = new VideoCommentEditorPlaybackController({
      doc: this.doc,
      videoRepository: this.dependencies.videoRepository,
      findVideoElement: () => this.state.videoElement
    });
    this.screenshotPreparation = new VideoScreenshotPreparationCoordinator({
      doc: this.doc,
      getCaptures: () => this.getTimestampCaptures(),
      getVisibleVideo: () => this.state.videoElement,
      captureFrame: this.dependencies.captureVideoFrameScreenshot,
      captureVisibleFrame: this.dependencies.captureVisibleVideoFrameScreenshot,
      onScreenshotPrepared: (capture, screenshot) => {
        void this.persistPreparedScreenshot(capture, screenshot);
      },
      syncPanel: () => this.syncPanel()
    });
  }

  private async ensureControllers(): Promise<void> {
    if (this.controllersReadyPromise) {
      return this.controllersReadyPromise;
    }

    this.controllersReadyPromise = import('./videoSessionControllers')
      .then(({ createVideoSessionControllers }) => {
        const controllers: VideoSessionControllers = createVideoSessionControllers({
          doc: this.doc,
          dependencies: this.dependencies,
          state: this.state,
          destinationState: this.destinationState,
          getMessages: () => this.messages,
          readCleanupState: () => ({
            isCleaningUp: this.isCleaningUp,
            shouldTrackSavingState: !this.mutationCoordinator.hasPendingMutations()
          }),
          onDraftRestored: () => undefined,
          onDraftScreenshotHydrationStart: () =>
            this.screenshotPreparation.suspendPendingRequests(),
          onDraftScreenshotHydrated: () => this.syncPanel(),
          onDraftScreenshotHydrationSettled: ({ isCurrent }) => {
            this.screenshotPreparation.resumePendingRequests();
            if (isCurrent) {
              this.screenshotPreparation.requestPendingScreenshots();
            }
          },
          createPlatformContext: () =>
            createVideoSessionPlatformContext({
              doc: this.doc,
              fragmentHighlighter: this.fragmentHighlighter,
              fragmentHighlightCoordinator: this.fragmentHighlightCoordinator,
              shadowSelectionBridge: this.shadowSelectionBridge
            }),
          getDocumentSelection: () => getVideoDocumentSelection(this.doc),
          isRangeInsideUi: (range) => isVideoRangeInsideUi(range),
          ensureCaptureHighlight: (capture) => this.ensureCaptureHighlight(capture),
          onSelectionAccepted: ({ selectedHtml, selectedText, range }) => {
            this.ingestTextCapture(selectedHtml, selectedText, '', range ?? undefined);
          },
          findVideoElement: () => this.doc.querySelector('video'),
          handleUrlChange: () => {
            void this.handleUrlChange();
          },
          handleVideoElementChange: (element) => this.handleVideoElementChange(element)
        });
        this.fragmentHighlighter = controllers.fragmentHighlighter;
        this.hintManager = controllers.hintManager;
        this.pendingSelection = controllers.pendingSelection;
        this.shadowSelectionBridge = controllers.shadowSelectionBridge;
        this.fragmentHighlightCoordinator = controllers.fragmentHighlightCoordinator;
        this.selectionCaptureController = controllers.selectionCaptureController;
        this.fragmentSelectionController = controllers.fragmentSelectionController;
        this.lifecycle = controllers.lifecycle;
        this.exporter = controllers.exporter;
        this.platformController = controllers.platformController;
        this.dom = controllers.dom;
        this.draftController = controllers.draftController;
        this.persistPreparedScreenshotCache = controllers.persistPreparedScreenshot;
      })
      .finally(() => {
        this.controllersReadyPromise = null;
      });

    return this.controllersReadyPromise;
  }

  async start(options: { initialCollapsed?: boolean } = {}): Promise<void> {
    await this.ensureControllers();
    this.isCleaningUp = false;

    if (isVideoSessionActive(this.doc)) {
      this.applyHint('ready');
      return;
    }

    const highlightThemePromise = loadVideoSessionHighlightTheme(this.dependencies).catch(
      () => DEFAULT_HIGHLIGHT_THEME
    );
    await this.dom.waitForDocumentReady();
    await this.commentEditorPlayback.start();
    registerVideoSession(this, this.doc);

    await initializeVideoSessionEnvironment({
      doc: this.doc,
      state: this.state,
      dependencies: this.dependencies,
      dom: this.dom,
      interactionHandlers: {
        onMouseDown: (event) => {
          this.releasePlaybackEditLeaseOnOutsidePointer(event);
          this.fragmentSelectionController.handleMouseDown(event);
        },
        onKeyDown: (event) => this.fragmentSelectionController.handleKeyDown(event),
        onKeyUp: (event) => this.fragmentSelectionController.handleKeyUp(event),
        onWindowBlur: () => {
          this.commentEditorPlayback.reset({ preserveTransactions: true });
          this.fragmentSelectionController.handleWindowBlur();
        }
      },
      selectionCaptureController: this.selectionCaptureController,
      fragmentHighlightCoordinator: this.fragmentHighlightCoordinator,
      refreshHint: () => this.dom.refreshHint(this.state),
      updateMessages: (messages) => {
        this.messages = messages;
      },
      updatePanelTexts: (panelMessages) => {
        this.dom.updateTexts(panelMessages);
      }
    });

    try {
      await finalizeVideoSessionStart({
        state: this.state,
        dom: this.dom,
        messages: this.messages,
        initialCollapsed: Boolean(options.initialCollapsed),
        platformController: this.platformController,
        lifecycle: this.lifecycle,
        operationContext: this.operationContext,
        fragmentHighlightCoordinator: this.fragmentHighlightCoordinator,
        highlightThemePromise,
        panelCallbacks: {
          onAddCapture: (source) => this.handleAddCapture(source),
          onFinish: () => this.finish(),
          onCancel: () => this.cancel(),
          onSelectDestination: (id) => this.selectDestination(id),
          onDeleteCapture: (id) => removeVideoSessionCapture(this.operationContext, id),
          onSubmitCaptureEdit: (id, comment) =>
            submitVideoSessionCaptureEdit(this.operationContext, id, comment),
          onToggleScreenshot: (id) => void this.toggleCaptureScreenshot(id),
          onFocusCapture: (id) => focusVideoSessionCapture(this.operationContext, id),
          onCaptureEditorFocus: (id) => this.commentEditorPlayback.beginCommentEditorLease(id),
          onCaptureEditorBlur: (id, scope) => {
            if (scope === 'outside-panel') {
              this.commentEditorPlayback.releaseCommentEditorLease(id);
            }
          },
          onCaptureEditorCancel: (id) => this.commentEditorPlayback.releaseForCapture(id, false),
          onCommentDraftChange: (drafts) => {
            applyVideoSessionCommentDrafts(this.state, drafts);
            void this.draftController.scheduleSave();
          }
        },
        applyHighlightTheme: (theme) => this.applyHighlightTheme(theme),
        applyHint: (state) => this.applyHint(state),
        refreshContext: () => this.refreshContext()
      });
      this.draftController.bindPersistence();
      this.screenshotPreparation.requestPendingScreenshots();
      await this.refreshDestinationPreview();
    } catch (error) {
      this.cleanup();
      throw error;
    }

    beginVideoSessionAnalytics(this.operationContext);
  }

  private async handleUrlChange(): Promise<void> {
    if (!this.draftController.isTrackingPageUrl(this.doc.location.href)) {
      await this.draftController.flushNow('restorable');
    }
    await handleVideoSessionUrlChange({
      platformController: this.platformController,
      state: this.state,
      refreshContext: () => this.refreshContext()
    });
  }

  private handleVideoElementChange(element: HTMLVideoElement | null): void {
    handleVideoSessionVideoElementChange({
      element,
      state: this.state,
      applyHint: (state) => this.applyHint(state),
      resolveHintState: (videoAvailable, captureCount) =>
        resolveVideoHintState(videoAvailable, captureCount)
    });
    this.screenshotPreparation.handleVideoElementChange(element);
  }

  private async refreshContext(): Promise<void> {
    const result = await refreshVideoSessionContext({
      platformController: this.platformController,
      applyHint: (state) => this.applyHint(state),
      syncPanel: () => this.syncPanel(),
      fragmentHighlightCoordinator: this.fragmentHighlightCoordinator
    });
    this.draftController.updateActivePageUrl(this.doc.location.href);
    if (result.restoreSource === 'legacy') {
      applyVideoSessionCommentDrafts(this.state, {}, { hydrateDom: true, dom: this.dom });
      void this.draftController.scheduleSave();
      this.screenshotPreparation.requestPendingScreenshots();
      await this.refreshDestinationPreview();
      return;
    }
    if (result.restoreSource === 'none') {
      this.draftController.clearRestoredDraftKey();
      if (!this.state.captures.length) {
        applyVideoSessionCommentDrafts(this.state, {}, { hydrateDom: true, dom: this.dom });
      }
    }
    this.screenshotPreparation.requestPendingScreenshots();
    await this.refreshDestinationPreview();
  }

  private async refreshDestinationPreview(): Promise<void> {
    const preview = await this.destinationState.refresh();
    this.dom.updateDestination(preview);
  }

  private releasePlaybackEditLeaseOnOutsidePointer(event: MouseEvent): void {
    if (this.dom.isEventInsidePanel(event)) {
      return;
    }
    this.commentEditorPlayback.releaseAll(true);
  }

  private async selectDestination(id: string): Promise<void> {
    this.destinationState.select(id);
    await this.refreshDestinationPreview();
    this.draftController.syncCommentDrafts();
    await this.draftController.scheduleSave();
  }

  private getTimestampCaptures(): VideoTimestampCapture[] {
    return this.state.captures.filter(
      (capture): capture is VideoTimestampCapture => capture.kind === 'timestamp'
    );
  }

  private createDestinationPayload(): ClipPayload {
    return createVideoSessionDestinationPayload(this.state, this.doc.location.href, this.doc.title);
  }

  private async persistPreparedScreenshot(
    capture: VideoTimestampCapture,
    screenshot: NonNullable<VideoTimestampCapture['screenshot']>
  ): Promise<void> {
    return this.mutationCoordinator.runExclusive(async () => {
      const persistPreparedScreenshotCache = this.persistPreparedScreenshotCache;
      if (!persistPreparedScreenshotCache) {
        return;
      }

      let saveResult;
      try {
        saveResult = await persistPreparedScreenshotCache(capture, screenshot);
      } catch (error) {
        console.warn('[VideoSession] Failed to persist prepared screenshot:', error);
        return;
      }
      if (saveResult.status !== 'saved') {
        console.debug('[VideoSession] Skipped prepared screenshot cache persistence:', saveResult);
        return;
      }

      emitVideoUsageEvent(this.dependencies, 'video_screenshot_captured', {
        screenshot_count_bucket: bucketCount(this.countRequestedScreenshots())
      });
    });
  }

  private countRequestedScreenshots(): number {
    return this.getTimestampCaptures().filter(
      (capture) =>
        hasRequestedTimestampScreenshot(capture) ||
        capture.screenshot !== undefined ||
        capture.screenshotRef !== undefined
    ).length;
  }

  ingestTextCapture(
    selectedHtml: string,
    selectedText: string,
    comment: string,
    selectionRange?: Range
  ): void {
    ingestVideoSessionTextCapture(
      this.operationContext,
      selectedHtml,
      selectedText,
      comment,
      selectionRange
    );
  }

  async addCurrentTimestamp(
    source: VideoAddCaptureSource = 'button',
    options: VideoSessionAddCaptureOptions = {}
  ): Promise<void> {
    await this.handleAddCapture(source, options);
  }

  async toggleCaptureScreenshot(id: string): Promise<void> {
    this.screenshotPreparation.cacheRequestedScreenshot(id);
    await toggleVideoSessionCaptureScreenshot(this.operationContext, id);
  }

  private async handleAddCapture(
    source: VideoAddCaptureSource = 'button',
    options: VideoSessionAddCaptureOptions = {}
  ): Promise<void> {
    const pauseVideo = options.pauseVideo ?? source === 'note-input';
    const capture = await handleVideoSessionAddCapture(this.operationContext, {
      ...options,
      pauseVideo
    });
    if (capture && pauseVideo && options.beginEditing !== false) {
      this.commentEditorPlayback.markAddNoteTransaction(capture.id);
    }
  }

  private applyHighlightTheme(theme: ReaderHighlightTheme): void {
    applyVideoSessionHighlightTheme(this.state, this.fragmentHighlighter, theme);
  }

  private syncPanel(): void {
    syncVideoSessionPanel({
      dom: this.dom,
      state: this.state,
      getFragmentElement: (capture) => this.getFragmentElement(capture),
      applyHint: (state) => this.applyHint(state)
    });
  }

  private getFragmentElement(capture: VideoFragmentCapture): HTMLElement | null {
    return getVideoSessionFragmentElement({
      capture,
      fragmentHighlighter: this.fragmentHighlighter,
      ensureCaptureHighlight: (nextCapture) => this.ensureCaptureHighlight(nextCapture)
    });
  }

  private ensureCaptureHighlight(capture: VideoFragmentCapture): void {
    ensureVideoSessionCaptureHighlight({
      capture,
      fragmentHighlighter: this.fragmentHighlighter,
      restoreHighlight: (nextCapture) => this.state.platformAdapter?.restoreHighlight(nextCapture)
    });
  }

  private applyHint(state: VideoHintState): void {
    this.dom.applyHint(state, this.state);
  }

  private async finish(): Promise<void> {
    await finishVideoSession(this.operationContext, () => this.cleanup());
  }

  private cancel(): void {
    void cancelVideoSession(this.operationContext, () => this.cleanup());
  }

  private cleanup(): void {
    if (this.isCleaningUp) {
      return;
    }
    this.isCleaningUp = true;
    this.screenshotPreparation.dispose();
    void this.draftController.dispose().catch((error) => {
      console.warn('[VideoSession] Failed to dispose draft persister:', error);
    });
    this.commentEditorPlayback.dispose();
    cleanupVideoSession(this.operationContext);
  }
}

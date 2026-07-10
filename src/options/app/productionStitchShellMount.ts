import { createThemeMediaQuery } from './productionStitchStateMapper';
import { installButtonPressScrollGuard } from './productionStitchScrollGuard';
import { createProductionStitchRenderLifecycle } from './productionStitchRenderLifecycle';
import {
  resolveMessagingRepositoryFallback,
  resolveOptionsRepositoryFallback,
  resolveRoot
} from './productionStitchShellState';
import type {
  MountedProductionStitchShell,
  ProductionStitchShellDependencies
} from './productionStitchShellTypes';
import { cleanupProductionStitchShell } from './productionStitchShellTeardown';
import {
  createProductionStitchMutator,
  resolveProductionDomainEntries,
  syncProductionDomainEntries
} from './productionStitchShellContext';
import { createProductionStitchShellActionRuntime } from './productionStitchShellActionRuntime';
import {
  createProductionStitchRenderDelegates,
  createProductionStitchShellSchemaRenderer
} from './productionStitchShellRenderDelegates';
import type { ProductionStitchRenderLifecycle } from './productionStitchRenderLifecycleTypes';
import { createProductionStitchShellRuntimeServices } from './productionStitchShellRuntimeServices';
import { resolveProductionStitchAssets } from './productionStitchShellAssetResolver';
import { createProductionStitchShellMutableState } from './productionStitchShellMutableState';
import { createProductionStitchAssetUrlResolver } from './productionStitchAssetUrlResolver';

export function mountProductionStitchShellFromDependencies({
  root,
  additionalActionHandlers,
  overlayRuntimeState,
  controller,
  initialOptions = null,
  getFooterMeta,
  getFooterView,
  getSettingsView,
  previewContent,
  language,
  messages = null,
  changeLanguage,
  optionsRepository,
  messagingRepository,
  storage,
  runtime,
  resolveAssetUrl: providedResolveAssetUrl,
  browserTarget: providedBrowserTarget,
  now
}: ProductionStitchShellDependencies): MountedProductionStitchShell {
  const stitchAssets = resolveProductionStitchAssets({
    previewContent,
    getFooterMeta,
    getFooterView,
    getSettingsView
  });
  const mountRoot = resolveRoot(root);
  const buttonPressScrollGuard = installButtonPressScrollGuard(mountRoot);
  const resolvedOptionsRepository = optionsRepository ?? resolveOptionsRepositoryFallback();
  const resolvedMessagingRepository = messagingRepository ?? resolveMessagingRepositoryFallback();
  const resolveAssetUrl =
    providedResolveAssetUrl ?? createProductionStitchAssetUrlResolver(runtime);
  const browserTarget = providedBrowserTarget ?? runtime?.getBrowserTarget() ?? 'chrome';
  const shellState = createProductionStitchShellMutableState({
    initialOptions,
    previewContent: stitchAssets.previewContent,
    language,
    messages,
    browserTarget,
    ...(overlayRuntimeState ? { overlayRuntimeState } : {})
  });
  const themeMediaQuery = createThemeMediaQuery();

  let renderLifecycle: ProductionStitchRenderLifecycle | null = null;
  const renderDelegates = createProductionStitchRenderDelegates(() => renderLifecycle);
  const getAppData = () => shellState.getAppData();
  const getConnectionNotice = () => shellState.getConnectionNotice();
  const getCurrentLanguage = () => shellState.getCurrentLanguage();
  const getCurrentMessages = () => shellState.getCurrentMessages();
  const getDomainMappingRows = () => shellState.getDomainMappingRows();
  const getDraft = () => shellState.getDraft();
  const getState = () => shellState.getState();
  const setAppData = (...args: Parameters<typeof shellState.setAppData>) =>
    shellState.setAppData(...args);
  const setConnectionNotice = (...args: Parameters<typeof shellState.setConnectionNotice>) =>
    shellState.setConnectionNotice(...args);
  const setDraft = (...args: Parameters<typeof shellState.setDraft>) =>
    shellState.setDraft(...args);
  const setDomainMappingRows = (...args: Parameters<typeof shellState.setDomainMappingRows>) =>
    shellState.setDomainMappingRows(...args);
  const setLanguageResource = (...args: Parameters<typeof shellState.setLanguageResource>) =>
    shellState.setLanguageResource(...args);
  const setMaintenanceLog = (...args: Parameters<typeof shellState.setMaintenanceLog>) =>
    shellState.setMaintenanceLog(...args);
  const setState = (...args: Parameters<typeof shellState.setState>) =>
    shellState.setState(...args);
  const createSchemaContext = () => shellState.createSchemaContext();
  const refreshAppData = () => shellState.refreshAppData();
  const render = () => renderDelegates.render();
  const applySystemThemePreferenceChange = () => renderDelegates.applySystemThemePreferenceChange();
  const renderActiveResourceModal = () => renderDelegates.renderActiveResourceModal();
  const scrollToPanel = (...args: Parameters<typeof renderDelegates.scrollToPanel>) =>
    renderDelegates.scrollToPanel(...args);
  const syncHighlightThemeControls = () => renderDelegates.syncHighlightThemeControls();
  const syncModifierControls = () => renderDelegates.syncModifierControls();
  const syncPreviewThemeControls = () => renderDelegates.syncPreviewThemeControls();
  const openResource = (...args: Parameters<typeof renderDelegates.openResource>) =>
    renderDelegates.openResource(...args);
  const mutate = createProductionStitchMutator({
    getState,
    render
  });

  const { persistence, storageController, widgetHost } = createProductionStitchShellRuntimeServices(
    {
      controller,
      optionsRepository: resolvedOptionsRepository,
      messagingRepository: resolvedMessagingRepository,
      ...(storage ? { storage } : {}),
      ...(now ? { now } : {}),
      getAppData,
      getCurrentMessages,
      getDraft,
      getState,
      setAppData,
      setConnectionNotice,
      setDraft,
      setDomainMappingRows,
      setMaintenanceLog,
      setState,
      getConnectionNotice,
      refreshAppData,
      render,
      scheduleDraftSave
    }
  );

  const actionRuntime = createProductionStitchShellActionRuntime({
    mountRoot,
    buttonPressScrollGuard,
    controller,
    optionsRepository: resolvedOptionsRepository,
    ...(changeLanguage ? { changeLanguage } : {}),
    getAppData,
    getCurrentLanguage,
    getCurrentMessages,
    getDraft,
    getState,
    setConnectionNotice,
    setDomainMappingRows,
    setLanguageResource,
    setMaintenanceLog,
    setState,
    createSchemaContext,
    mutate,
    currentDomainEntries: () => resolveProductionDomainEntries(getDomainMappingRows()),
    refreshAppData,
    syncOverlayRuntimeState: () => shellState.syncOverlayRuntimeState(),
    refreshOptions: (options) => mounted.refreshOptions(options),
    render,
    renderActiveResourceModal,
    scheduleDraftSave,
    scrollToPanel,
    syncDomainEntries: (entries) => {
      setDomainMappingRows(syncProductionDomainEntries(getDraft(), entries));
    },
    syncHighlightThemeControls,
    syncModifierControls,
    syncPreviewThemeControls,
    openResource,
    ...(additionalActionHandlers ? { additionalActionHandlers } : {}),
    persistence,
    storageController,
    widgetHost
  });

  function dispatch(actionId: string, args: unknown[] = [], value?: unknown, event?: Event): void {
    actionRuntime.dispatch(actionId, args, value, event);
  }
  const schemaRenderer = createProductionStitchShellSchemaRenderer({
    createSchemaContext,
    dispatch,
    mutate,
    render,
    resolveAssetUrl,
    widgetHost
  });

  renderLifecycle = createProductionStitchRenderLifecycle({
    getFooterMeta: stitchAssets.getFooterMeta,
    getFooterView: stitchAssets.getFooterView,
    mountRoot,
    getAppData,
    getCurrentLanguage,
    getSettingsView: stitchAssets.getSettingsView,
    getState,
    setState,
    createSchemaContext,
    dispatch,
    resolveAssetUrl,
    schemaRenderer,
    widgetHost
  });
  const unsubscribeOverlayRuntimeState = overlayRuntimeState?.subscribe((snapshot) => {
    if (shellState.setOverlayRuntimeSnapshot(snapshot)) {
      renderDelegates.render();
    }
  });

  function scheduleDraftSave(): void {
    shellState.refreshAppData();
    controller.scheduleAutoSave(() => mounted.collectDraft());
  }

  const mounted: MountedProductionStitchShell = {
    cleanup() {
      unsubscribeOverlayRuntimeState?.();
      renderLifecycle?.cleanup();
      cleanupProductionStitchShell({
        mountRoot,
        buttonPressScrollGuard,
        themeMediaQuery,
        applySystemThemePreferenceChange,
        schemaRenderer,
        widgetHost
      });
    },
    collectDraft() {
      return widgetHost.collectDraftWithWidgets();
    },
    refreshOptions(options = null) {
      shellState.resetOptions(options);
      widgetHost.resetDirty();
      renderDelegates.render();
    },
    setMessages(nextMessages, nextLanguage) {
      shellState.setLanguageResource({
        messages: nextMessages,
        language: nextLanguage
      });
      renderDelegates.render();
    }
  };

  themeMediaQuery.addEventListener?.('change', applySystemThemePreferenceChange);

  render();
  void persistence.loadUsageStatsFromStorage();
  return mounted;
}

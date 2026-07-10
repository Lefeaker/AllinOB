import { createActionRuntime } from '@options/schema-runtime/actionRuntime';
import type { ActionRegistry } from '@options/schema-runtime/actionRuntime';
import type { Language, Messages } from '@i18n';
import type { IOptionsRepository } from '@shared/repositories';
import { createAnalyticsEventMessage } from '@shared/types/analytics';
import type { AnalyticsRuntimeEventPayload } from '@shared/types/analytics';
import type { CompleteOptions, StoredOptions } from '@shared/types/options';
import type { PreviewContent, PreviewStoreState, SchemaContext } from '@options/stitch/types';
import type { OptionsController } from './optionsController';
import { createProductionStitchActions } from './productionStitchActions';
import type { ProductionStitchPersistence } from './productionStitchPersistence';
import type { ButtonPressScrollGuard } from './productionStitchScrollGuard';
import {
  captureOptionsScroll,
  restoreOptionsScrollSoon,
  shouldPreserveButtonActionScroll
} from './productionStitchScrollGuard';
import type { ProductionStitchStorageController } from './productionStitchStorageController';
import {
  applyOutputPresetToDraft,
  applyTemplateStateToDraft,
  updateClassifierField,
  updateDraftPath
} from './productionStitchShellState';
import type { ProductionStitchWidgetHost } from './productionStitchWidgetHost';

interface ProductionStitchShellActionRuntimeOptions {
  mountRoot: HTMLElement;
  buttonPressScrollGuard: ButtonPressScrollGuard;
  controller: Pick<OptionsController, 'loadRaw' | 'scheduleAutoSave'>;
  optionsRepository: Pick<IOptionsRepository, 'set'>;
  changeLanguage?: (
    language: Language
  ) => Promise<{ messages: Messages | null; language: Language }>;
  getAppData(): PreviewContent;
  getCurrentLanguage(): Language;
  getCurrentMessages(): Messages | null;
  getDraft(): CompleteOptions;
  getState(): PreviewStoreState;
  setConnectionNotice(notice: PreviewContent['storage']['connectionNotice']): void;
  setDomainMappingRows(entries: Array<[string, string]>): void;
  setLanguageResource(resource: { messages: Messages | null; language: Language }): void;
  setMaintenanceLog(log: PreviewContent['maintenanceLog']): void;
  setState(state: PreviewStoreState): void;
  createSchemaContext(): SchemaContext;
  mutate(mutator: (draftState: PreviewStoreState) => void, options?: { silent?: boolean }): void;
  currentDomainEntries(): Array<[string, string]>;
  refreshAppData(): void;
  refreshOptions(options: StoredOptions | CompleteOptions | null): void;
  render(): void;
  renderActiveResourceModal(): void;
  scheduleDraftSave(): void;
  scrollToPanel(panelId: string): void;
  syncDomainEntries(entries: Array<[string, string]>): void;
  syncHighlightThemeControls(): void;
  syncModifierControls(): void;
  syncPreviewThemeControls(): void;
  openResource(resourceId: string): void;
  persistence: ProductionStitchPersistence;
  storageController: ProductionStitchStorageController;
  widgetHost: ProductionStitchWidgetHost;
  additionalActionHandlers?: ActionRegistry<PreviewStoreState, PreviewContent>;
}

export interface ProductionStitchShellActionRuntime {
  dispatch(actionId: string, args?: unknown[], value?: unknown, event?: Event): void;
}

type AnalyticsSection =
  | 'overview'
  | 'vault'
  | 'storage'
  | 'templates'
  | 'privacy'
  | 'onboarding'
  | 'usage'
  | 'video'
  | 'reader'
  | 'advanced';

type TrackablePersistence = ProductionStitchPersistence & {
  trackUsageEvent?: (message: AnalyticsRuntimeEventPayload) => Promise<void>;
};
const PANEL_SECTION_MAP: Record<string, AnalyticsSection> = {
  overview: 'overview',
  storage: 'storage',
  output: 'templates',
  'capture-sources': 'advanced',
  'capture-behavior': 'advanced',
  maintenance: 'advanced'
};

const ACTION_SECTION_MAP: Record<string, AnalyticsSection> = {
  'maintenance:diagnose': 'advanced',
  'output:applyPreset': 'templates',
  'highlight:setTheme': 'reader',
  'modifier:setEnabled': 'advanced',
  'modifier:toggleKey': 'advanced',
  'routing:add': 'storage',
  'routing:remove': 'storage',
  'storage:addVault': 'storage',
  'storage:removeVault': 'storage',
  'storage:cancelLocalFolderDelete': 'storage',
  'storage:deleteLocalFolder': 'storage',
  'domain:add': 'templates',
  'domain:remove': 'templates'
};

const TRACKED_SYNCHRONOUS_ACTIONS = new Set(Object.keys(ACTION_SECTION_MAP));

const RESOURCE_SECTION_MAP: Record<string, AnalyticsSection> = {
  'privacy-policy': 'privacy',
  'data-usage': 'privacy',
  'terms-of-use': 'privacy',
  'plugin-setup': 'onboarding'
};

function eventButton(value: unknown): HTMLButtonElement | null {
  return value instanceof Event && value.currentTarget instanceof HTMLButtonElement
    ? value.currentTarget
    : null;
}

function sanitizeActionId(actionId: string): string {
  return actionId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function createProductionOptionsTelemetry(persistence: ProductionStitchPersistence) {
  const trackablePersistence = persistence as TrackablePersistence;

  async function send(message: AnalyticsRuntimeEventPayload): Promise<void> {
    try {
      await trackablePersistence.trackUsageEvent?.(message);
    } catch {
      // Telemetry is best-effort and must not affect options behavior.
    }
  }

  function trackSectionView(panelId: string): void {
    const section = PANEL_SECTION_MAP[panelId];
    if (!section) {
      return;
    }
    void send(
      createAnalyticsEventMessage('options_section_viewed', {
        section
      })
    );
  }

  function trackResourceOpen(resourceId: string): void {
    const action = sanitizeActionId('resource:open');
    const section = RESOURCE_SECTION_MAP[resourceId];
    void send(
      createAnalyticsEventMessage('options_action_completed', {
        action,
        outcome: 'completed',
        ...(section ? { section } : {})
      })
    );
  }

  function trackSynchronousAction(actionId: string): void {
    if (!TRACKED_SYNCHRONOUS_ACTIONS.has(actionId)) {
      return;
    }
    void send(
      createAnalyticsEventMessage('options_action_completed', {
        action: sanitizeActionId(actionId),
        outcome: 'completed',
        section: ACTION_SECTION_MAP[actionId]
      })
    );
  }

  function trackMaintenanceOutcome(
    actionId: 'maintenance:repair' | 'maintenance:reload',
    outcome: 'completed' | 'failed'
  ): void {
    void send(
      createAnalyticsEventMessage('options_action_completed', {
        action: sanitizeActionId(actionId),
        outcome,
        section: 'advanced'
      })
    );
  }

  function trackThemeChanged(theme: 'light' | 'dark' | 'system'): void {
    void send(
      createAnalyticsEventMessage('options_theme_changed', {
        theme
      })
    );
  }

  function trackLanguageChanged(language: Language): void {
    void send(
      createAnalyticsEventMessage('options_language_changed', {
        language
      })
    );
  }

  function trackExperimentalFeatureToggle(featureKey: string, enabled: boolean): void {
    void send(
      createAnalyticsEventMessage('experimental_feature_toggled', {
        feature_key: featureKey,
        enabled
      })
    );
  }

  return {
    trackExperimentalFeatureToggle,
    trackLanguageChanged,
    trackMaintenanceOutcome,
    trackResourceOpen,
    trackSectionView,
    trackSynchronousAction,
    trackThemeChanged
  };
}

export function createProductionStitchShellActionRuntime(
  options: ProductionStitchShellActionRuntimeOptions
): ProductionStitchShellActionRuntime {
  const {
    additionalActionHandlers,
    buttonPressScrollGuard,
    changeLanguage,
    controller,
    mountRoot,
    optionsRepository,
    persistence,
    storageController,
    widgetHost
  } = options;
  const telemetry = createProductionOptionsTelemetry(persistence);
  const productionHandlers = createProductionStitchActions({
    getAppData: () => options.getAppData(),
    getCurrentLanguage: () => options.getCurrentLanguage(),
    getDraft: () => options.getDraft(),
    getMessages: () => options.getCurrentMessages(),
    getState: () => options.getState(),
    setConnectionNotice: (notice) => options.setConnectionNotice(notice),
    setLanguageResource: (resource) => options.setLanguageResource(resource),
    setMaintenanceLog: (log) => options.setMaintenanceLog(log),
    setState: (state) => options.setState(state),
    activateVaultLocalFolder: (index) => storageController.activateVaultLocalFolder(index),
    applyConnectionNotice: (result) => storageController.applyConnectionNotice(result),
    applyOutputPreset: (name) =>
      applyOutputPresetToDraft({
        draft: options.getDraft(),
        state: options.getState(),
        setDomainMappingRows: (entries) => options.setDomainMappingRows(entries),
        refreshAppData: () => options.refreshAppData(),
        scheduleDraftSave: () => options.scheduleDraftSave(),
        render: () => options.render(),
        name
      }),
    applyTemplateStateToDraft: () =>
      applyTemplateStateToDraft(options.getDraft(), options.getState()),
    ...(changeLanguage ? { changeLanguage } : {}),
    chooseVaultLocalFolder: (index) => storageController.chooseVaultLocalFolder(index),
    clearAnalyticsPrivacyData: () => persistence.clearAnalyticsPrivacyData(),
    clearVaultLocalFolder: (index) => storageController.clearVaultLocalFolder(index),
    collectDraftWithWidgets: () => widgetHost.collectDraftWithWidgets(),
    copyConfigurationToClipboard: (button) => persistence.copyConfigurationToClipboard(button),
    currentDomainEntries: () => options.currentDomainEntries(),
    eventButton,
    ensureVaultRouter: () => storageController.ensureVaultRouter(),
    importConfigurationWithStatus: (button) => persistence.importConfigurationWithStatus(button),
    markWidgetDirty: (key) => widgetHost.markDirty(key),
    openResource: (resourceId) => {
      options.openResource(resourceId);
      telemetry.trackResourceOpen(resourceId);
    },
    persistPrivacyPreference: (field, value) => persistence.persistPrivacyPreference(field, value),
    persistThemePreference: (theme) => {
      void optionsRepository.set({ interfaceTheme: theme } as Partial<CompleteOptions>);
    },
    refreshAppData: () => options.refreshAppData(),
    render: () => options.render(),
    renderActiveResourceModal: () => options.renderActiveResourceModal(),
    repairConfiguration: async () => {
      try {
        await persistence.repairConfiguration();
        telemetry.trackMaintenanceOutcome('maintenance:repair', 'completed');
      } catch (error) {
        telemetry.trackMaintenanceOutcome('maintenance:repair', 'failed');
        throw error;
      }
    },
    reloadOptions: async () => {
      try {
        const loaded = await controller.loadRaw();
        options.refreshOptions(loaded);
        telemetry.trackMaintenanceOutcome('maintenance:reload', 'completed');
      } catch (error) {
        telemetry.trackMaintenanceOutcome('maintenance:reload', 'failed');
        throw error;
      }
    },
    resetUsageData: () => persistence.resetUsageData(),
    runVaultListConnectionTest: () => storageController.runVaultListConnectionTest(),
    scheduleDraftSave: () => options.scheduleDraftSave(),
    scrollToPanel: (panelId) => {
      options.scrollToPanel(panelId);
      telemetry.trackSectionView(panelId);
    },
    syncDomainEntries: (entries) => options.syncDomainEntries(entries),
    syncHighlightThemeControls: () => options.syncHighlightThemeControls(),
    syncModifierControls: () => options.syncModifierControls(),
    syncPreviewThemeControls: () => options.syncPreviewThemeControls(),
    syncRoutingRulesToDraft: () => storageController.syncRoutingRulesToDraft(),
    trackExperimentalFeatureToggle: (featureKey, enabled) =>
      telemetry.trackExperimentalFeatureToggle(featureKey, enabled),
    trackLanguageChanged: (language) => telemetry.trackLanguageChanged(language),
    trackThemeChanged: (theme) => telemetry.trackThemeChanged(theme),
    updateClassifierField: (field, value) =>
      updateClassifierField(
        options.getDraft(),
        options.getState(),
        () => options.scheduleDraftSave(),
        field,
        value
      ),
    updateDraftPath: (path, value) =>
      updateDraftPath(options.getDraft(), options.getState(), path, value),
    updateVaultField: (index, field, value) =>
      storageController.updateVaultField(index, field, value)
  });
  const actionRuntime = createActionRuntime<PreviewStoreState, PreviewContent>({
    getContext: () => options.createSchemaContext(),
    mutate: (mutator, mutationOptions) => options.mutate(mutator, mutationOptions),
    handlers: mergeActionHandlers(productionHandlers, additionalActionHandlers),
    onUnhandledAction: () => {
      controller.scheduleAutoSave(() => options.getDraft());
    }
  });

  function dispatch(actionId: string, args: unknown[] = [], value?: unknown, event?: Event): void {
    const scrollSnapshot = shouldPreserveButtonActionScroll(actionId)
      ? (buttonPressScrollGuard.getSnapshot() ?? captureOptionsScroll(mountRoot))
      : null;
    widgetHost.flushDirtyWidgets();
    actionRuntime.dispatch({ id: actionId, args }, value === undefined ? event : value);
    telemetry.trackSynchronousAction(actionId);
    if (scrollSnapshot) {
      restoreOptionsScrollSoon(mountRoot, scrollSnapshot);
    }
  }

  return { dispatch };
}

function mergeActionHandlers(
  productionHandlers: ActionRegistry<PreviewStoreState, PreviewContent>,
  additionalActionHandlers: ActionRegistry<PreviewStoreState, PreviewContent> | undefined
): ActionRegistry<PreviewStoreState, PreviewContent> {
  if (!additionalActionHandlers) {
    return productionHandlers;
  }

  const merged: ActionRegistry<PreviewStoreState, PreviewContent> = {
    ...productionHandlers
  };

  for (const [actionId, handler] of Object.entries(additionalActionHandlers)) {
    if (Object.prototype.hasOwnProperty.call(merged, actionId)) {
      console.warn(`[Options] Ignoring additional Stitch action handler for "${actionId}".`);
      continue;
    }
    merged[actionId] = handler;
  }

  return merged;
}

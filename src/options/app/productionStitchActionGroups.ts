import type { ActionRegistry } from '@options/schema-runtime/actionRuntime';
import type { PreviewContent, PreviewStoreState } from '@options/stitch/types';
import type { Messages } from '@i18n';
import { resolveSchemaMessage } from '@options/stitch/schema/i18n';
import type { ConnectionTestResult } from '@shared/types/connection';
import type { CompleteOptions } from '@shared/types/options';
import type { VaultRouterConfig } from '@shared/types/vault';
import { toRoutingRules } from './productionStitchStateMapper';

type ProductionStitchActions = ActionRegistry<PreviewStoreState, PreviewContent>;
interface ProductionStitchActionGroupContext {
  getAppData(): PreviewContent;
  getDraft(): CompleteOptions;
  getMessages(): Messages | null;
  getState(): PreviewStoreState;
  setConnectionNotice(notice: PreviewContent['storage']['connectionNotice']): void;
  activateVaultLocalFolder(index: number): Promise<void>;
  applyConnectionNotice(result: ConnectionTestResult): void;
  chooseVaultLocalFolder(index: number): Promise<void>;
  clearVaultLocalFolder(index: number): void;
  currentDomainEntries(): Array<[string, string]>;
  ensureVaultRouter(): VaultRouterConfig;
  refreshAppData(): void;
  render(): void;
  runVaultListConnectionTest(): Promise<ConnectionTestResult>;
  scheduleDraftSave(): void;
  syncDomainEntries(entries: Array<[string, string]>): void;
  syncRoutingRulesToDraft(): void;
  updateVaultField(index: number, field: string, value: unknown): void;
}

export function createProductionRoutingActions(
  context: ProductionStitchActionGroupContext
): ProductionStitchActions {
  return {
    'routing:add': () => {
      const state = context.getState();
      const draft = context.getDraft();
      state.routingRules = [
        ...state.routingRules,
        {
          type: 'Domain',
          pattern: '',
          target: context.getAppData().storage.vaults[0]?.name ?? draft.rest.vault,
          priority: 50,
          enabled: true
        }
      ];
      context.syncRoutingRulesToDraft();
      context.scheduleDraftSave();
      context.render();
    },
    'routing:remove': ({ args }) => {
      const index = Number(args[0] ?? -1);
      const state = context.getState();
      state.routingRules = state.routingRules.filter((_, ruleIndex) => ruleIndex !== index);
      context.syncRoutingRulesToDraft();
      context.scheduleDraftSave();
      context.render();
    },
    'routing:updateField': ({ args, value }) => {
      const state = context.getState();
      const rule = state.routingRules[Number(args[0] ?? -1)];
      const field = String(args[1] ?? '');
      if (rule && field) {
        (rule as unknown as Record<string, unknown>)[field] = value;
        context.syncRoutingRulesToDraft();
        context.scheduleDraftSave();
      }
    },
    'routing:updatePriority': ({ args, value }) => {
      const rule = context.getState().routingRules[Number(args[0] ?? -1)];
      if (rule) {
        rule.priority = typeof value === 'number' || value === '' ? value : Number(value);
        context.syncRoutingRulesToDraft();
        context.scheduleDraftSave();
      }
    }
  };
}

export function createProductionStorageActions(
  context: ProductionStitchActionGroupContext
): ProductionStitchActions {
  return {
    'storage:addVault': () => {
      const draft = context.getDraft();
      const router = context.ensureVaultRouter();
      const nextIndex = router.vaults.length + 1;
      router.vaults.push({
        id: `vault-${nextIndex}`,
        name: `Vault ${nextIndex}`,
        vault: `Vault ${nextIndex}`,
        httpsUrl: draft.rest.httpsUrl ?? draft.rest.baseUrl,
        httpUrl: draft.rest.httpUrl ?? draft.rest.baseUrl,
        apiKey: '',
        enabled: true
      });
      draft.vaultRouter = router;
      context.scheduleDraftSave();
      context.render();
    },
    'storage:removeVault': ({ args }) => {
      const index = Number(args[0] ?? -1);
      const draft = context.getDraft();
      const router = context.ensureVaultRouter();
      const vault = router.vaults[index];
      if (!vault || vault.isDefault || vault.id === router.defaultVaultId || index === 0) {
        return;
      }
      router.vaults.splice(index, 1);
      router.rules = (router.rules ?? []).filter((rule) => rule.vaultId !== vault.id);
      draft.vaultRouter = router;
      context.getState().routingRules = toRoutingRules(draft);
      context.scheduleDraftSave();
      context.render();
    },
    'storage:updateVaultField': ({ args, value }) => {
      context.updateVaultField(Number(args[0] ?? -1), String(args[1] ?? ''), value);
    },
    'storage:activateLocalFolder': ({ args }) => {
      void context.activateVaultLocalFolder(Number(args[0] ?? -1));
    },
    'storage:chooseLocalFolder': ({ args }) => {
      void context.chooseVaultLocalFolder(Number(args[0] ?? -1));
    },
    'storage:deleteLocalFolder': ({ args }) => {
      context.clearVaultLocalFolder(Number(args[0] ?? -1));
    },
    'storage:cancelLocalFolderDelete': () => {
      context.getState().activeLocalFolderVaultIndex = null;
      context.render();
    },
    'storage:testConnection': () => {
      void (async () => {
        try {
          context.applyConnectionNotice(await context.runVaultListConnectionTest());
        } catch (error) {
          context.setConnectionNotice({
            title: resolveSchemaMessage(
              context.getMessages(),
              'schemaStorageConnectionNoticeTitle'
            ),
            body: error instanceof Error ? error.message : String(error),
            variant: 'danger'
          });
          context.refreshAppData();
        }
        context.render();
      })();
    }
  };
}

export function createProductionDomainActions(
  context: ProductionStitchActionGroupContext
): ProductionStitchActions {
  return {
    'domain:add': () => {
      const entries = context
        .currentDomainEntries()
        .filter(([domain, alias]) => domain.trim() || alias.trim());
      entries.push([`example-${entries.length + 1}.com`, 'folder']);
      context.syncDomainEntries(entries);
      context.scheduleDraftSave();
      context.render();
    },
    'domain:update': ({ args, value }) => {
      const index = Number(args[0] ?? -1);
      const field = String(args[1] ?? '');
      const entries = context.currentDomainEntries();
      const entry = entries[index];
      if (!entry) {
        return;
      }
      if (field === 'domain') {
        entry[0] = String(value ?? '');
      } else if (field === 'alias') {
        entry[1] = String(value ?? '');
      }
      context.syncDomainEntries(entries);
      context.scheduleDraftSave();
    },
    'domain:remove': ({ args }) => {
      const index = Number(args[0] ?? -1);
      const entries = context
        .currentDomainEntries()
        .filter((_, entryIndex) => entryIndex !== index);
      context.syncDomainEntries(entries);
      context.scheduleDraftSave();
      context.render();
    }
  };
}

export function updateExperimentalBoolean(
  draft: CompleteOptions,
  state: PreviewStoreState,
  field: 'pageSummaryEnabled' | 'readingOverlaySummaryEnabled' | 'subtitleTranslationEnabled'
): void {
  if (field === 'pageSummaryEnabled') {
    draft.pageSummary.enabled = false;
  }
  if (field === 'readingOverlaySummaryEnabled') {
    draft.readingOverlaySummary.enabled = false;
  }
  if (field === 'subtitleTranslationEnabled') {
    draft.subtitleTranslation.enabled = false;
  }
  state[field] = false;
}

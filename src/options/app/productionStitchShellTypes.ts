import type { StorageService } from '@platform/interfaces/storage';
import type { RuntimeService } from '@platform/interfaces/runtime';
import type { IOptionsRepository, IMessagingRepository } from '@shared/repositories';
import type { CompleteOptions, StoredOptions } from '@shared/types/options';
import type { Language, Messages } from '@i18n';
import type { ActionRegistry } from '@options/schema-runtime/actionRuntime';
import type {
  PreviewContent,
  PreviewStoreState,
  SchemaContext,
  ViewSchema
} from '@options/stitch/types';
import type { OptionsController } from './optionsController';
import type { ProductionStitchAssetUrlResolver } from './productionStitchAssetUrlResolver';
import type {
  OptionsOverlayAppDataSnapshot,
  OptionsOverlayRuntimeStatePort
} from './optionsOverlayRuntimeState';

export interface MountedProductionStitchShell {
  cleanup(): void;
  collectDraft(): CompleteOptions;
  refreshOptions(options?: StoredOptions | CompleteOptions | null): void;
  setMessages(messages: Messages | null, language: Language): void;
}

export interface ProductionStitchShellDependencies {
  root?: HTMLElement | null;
  controller: OptionsController;
  initialOptions?: StoredOptions | CompleteOptions | null;
  previewContent?: PreviewContent;
  getFooterMeta?: (id: string) => { openMode: 'modal' | 'page'; href?: string } | null;
  getFooterView?: (id: string, ctx: SchemaContext) => ViewSchema | null;
  getSettingsView?: (id: string, ctx: SchemaContext) => ViewSchema | null;
  messages?: Messages | null;
  language: Language;
  changeLanguage?: (
    language: Language
  ) => Promise<{ messages: Messages | null; language: Language }>;
  optionsRepository?: Pick<IOptionsRepository, 'get' | 'set' | 'onChange'>;
  messagingRepository?: Pick<IMessagingRepository, 'send' | 'onMessage'>;
  storage?: StorageService;
  runtime?: Pick<RuntimeService, 'getURL' | 'getBrowserTarget'>;
  resolveAssetUrl?: ProductionStitchAssetUrlResolver;
  browserTarget?: SchemaContext['browserTarget'];
  additionalActionHandlers?: ActionRegistry<PreviewStoreState, PreviewContent>;
  overlayRuntimeState?: OptionsOverlayRuntimeStatePort<OptionsOverlayAppDataSnapshot>;
  now?: () => number;
}

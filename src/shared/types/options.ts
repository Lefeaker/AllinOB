import type { VaultRouterConfig } from './vault';
import type { TaxonomyConfig, ReadonlyDeep } from './taxonomy';
import type { YamlConfigOverrides } from './yamlConfig';

export type ClassifierProvider = 'openai' | 'compatible' | 'ollama';
export type InterfaceTheme = 'dark' | 'light' | 'system';

export interface RestOptions {
  baseUrl: string;
  httpsUrl?: string;
  httpUrl?: string;
  vault: string;
  apiKey: string;
  /** Legacy persisted compatibility only; runtime write routing does not use this field. */
  rootDir?: string;
  localFolderId?: string | undefined;
  localFolderName?: string | undefined;
}

export interface TemplateOptions {
  article: string;
  video: string;
  fragment: string;
  reading: string;
  ai: string;
}

export interface AiChatOptions {
  includeTimestamps: boolean;
  userName: string;
}

export interface DeepResearchOptions {
  pureMode: boolean;
}

export type FragmentContextMode = 'chars' | 'sentences';

export type FragmentModifierKey = 'alt' | 'meta' | 'ctrl' | 'shift';

export type ReadingExportMode = 'highlights' | 'full';

export type ReaderHighlightTheme =
  | 'gradient'
  | 'purple'
  | 'neonYellow'
  | 'neonGreen'
  | 'neonOrange';

export interface ReadingSessionOptions {
  exportMode: ReadingExportMode;
  highlightTheme: ReaderHighlightTheme;
}

export interface VideoScreenshotAttachmentOptions {
  locationTemplate: string;
  fileNameTemplate: string;
  markdownUrlFormat: string;
}

export interface VideoOptions {
  floatingPromptEnabled: boolean;
  promptButtonLabel: string;
  promptShortcut: string;
  controlBarAutoPause: boolean;
  controlBarScreenshot: boolean;
  commentEditorAutoPause: boolean;
  promptPosition?: { x: number; y: number };
  screenshotAttachment: VideoScreenshotAttachmentOptions;
}

export interface StoredVideoOptions extends Omit<Partial<VideoOptions>, 'screenshotAttachment'> {
  screenshotAttachment?: Partial<VideoScreenshotAttachmentOptions>;
}

export interface FragmentClipperOptions {
  useFootnoteFormat: boolean;
  captureContext: boolean;
  contextLength: number;
  contextMode: FragmentContextMode;
  selectionModifierEnabled: boolean;
  selectionModifierKeys: FragmentModifierKey[];
  keyboardShortcutsEnabled: boolean;
}

export interface ClassifierOptions {
  enabled: boolean;
  provider: ClassifierProvider;
  endpoint: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  taxonomy: ReadonlyDeep<TaxonomyConfig>;
}

export interface ExperimentalAiOptions {
  provider: string;
  model: string;
  apiUrl: string;
  apiKey: string;
}

export interface PageSummaryOptions {
  enabled: boolean;
}

export interface ReadingOverlaySummaryOptions {
  enabled: boolean;
}

export interface PrivacyPreferencesOptions {
  analytics: boolean;
  errorReporting: boolean;
  debugMode: boolean;
}

export interface SubtitleTranslationOptions {
  enabled: boolean;
  targetLanguage: string;
}

export interface StoredOptions {
  interfaceTheme?: InterfaceTheme;
  rest?: Partial<RestOptions> & { baseUrl?: string };
  templates?: Partial<TemplateOptions> & { fragment?: string; reading?: string };
  domainMappings?: Record<string, string>;
  aiChat?: Partial<AiChatOptions>;
  deepResearch?: Partial<DeepResearchOptions>;
  fragmentClipper?: Partial<FragmentClipperOptions>;
  readingSession?: Partial<ReadingSessionOptions>;
  video?: StoredVideoOptions;
  classifier?: Partial<ClassifierOptions>;
  experimentalAi?: Partial<ExperimentalAiOptions>;
  pageSummary?: Partial<PageSummaryOptions>;
  readingOverlaySummary?: Partial<ReadingOverlaySummaryOptions>;
  subtitleTranslation?: Partial<SubtitleTranslationOptions>;
  privacyPreferences?: Partial<PrivacyPreferencesOptions>;
  vaultRouter?: VaultRouterConfig;
  yamlConfig?: YamlConfigOverrides | null;
  [key: string]: unknown;
}

export interface CompleteOptions extends StoredOptions {
  interfaceTheme?: InterfaceTheme;
  rest: RestOptions;
  templates: TemplateOptions;
  aiChat: AiChatOptions;
  deepResearch: DeepResearchOptions;
  fragmentClipper: FragmentClipperOptions;
  readingSession: ReadingSessionOptions;
  video: VideoOptions;
  classifier: ClassifierOptions;
  experimentalAi: ExperimentalAiOptions;
  pageSummary: PageSummaryOptions;
  readingOverlaySummary: ReadingOverlaySummaryOptions;
  subtitleTranslation: SubtitleTranslationOptions;
  privacyPreferences?: PrivacyPreferencesOptions;
  domainMappings: Record<string, string>;
}

export interface OptionsState {
  interfaceTheme?: InterfaceTheme;
  rest: RestOptions;
  templates: TemplateOptions;
  domainMappings: Record<string, string>;
  aiChat?: AiChatOptions;
  deepResearch?: DeepResearchOptions;
  fragmentClipper?: FragmentClipperOptions;
  readingSession?: ReadingSessionOptions;
  video?: VideoOptions;
  classifier?: ClassifierOptions;
  experimentalAi?: ExperimentalAiOptions;
  pageSummary?: PageSummaryOptions;
  readingOverlaySummary?: ReadingOverlaySummaryOptions;
  subtitleTranslation?: SubtitleTranslationOptions;
  privacyPreferences?: PrivacyPreferencesOptions;
  vaultRouter?: VaultRouterConfig;
  yamlConfig?: YamlConfigOverrides | null;
}

import { z } from 'zod';
import { VaultRouterConfigSchema } from './vault.schema';
import { YamlConfigOverridesSchema } from './yamlConfig.schema';

/**
 * RestOptions Schema
 * 替换 src/shared/types/options.ts 中的 RestOptions 接口
 */
export const RestOptionsSchema = z.object({
  baseUrl: z.string().url('Must be a valid URL'),
  httpsUrl: z.string().url().optional(),
  httpUrl: z.string().url().optional(),
  vault: z.string().min(1, 'Vault name is required'),
  apiKey: z.string().min(10, 'API key must be at least 10 characters'),
  localFolderId: z.string().optional(),
  localFolderName: z.string().optional()
});

/**
 * TemplateOptions Schema
 */
export const TemplateOptionsSchema = z.object({
  article: z.string(),
  video: z.string(),
  fragment: z.string(),
  reading: z.string(),
  ai: z.string()
});

/**
 * AiChatOptions Schema
 */
export const AiChatOptionsSchema = z.object({
  includeTimestamps: z.boolean(),
  userName: z.string()
});

/**
 * DeepResearchOptions Schema
 */
export const DeepResearchOptionsSchema = z.object({
  pureMode: z.boolean()
});

/**
 * FragmentContextMode Schema
 */
export const FragmentContextModeSchema = z.enum(['chars', 'sentences']);

/**
 * FragmentModifierKey Schema
 */
export const FragmentModifierKeySchema = z.enum(['alt', 'meta', 'ctrl', 'shift']);

/**
 * ReadingExportMode Schema
 */
export const ReadingExportModeSchema = z.enum(['highlights', 'full']);

/**
 * ReaderHighlightTheme Schema
 */
export const ReaderHighlightThemeSchema = z.enum([
  'gradient',
  'purple',
  'neonYellow',
  'neonGreen',
  'neonOrange'
]);

/**
 * ReadingSessionOptions Schema
 */
export const ReadingSessionOptionsSchema = z.object({
  exportMode: ReadingExportModeSchema,
  highlightTheme: ReaderHighlightThemeSchema
});

export const VideoScreenshotAttachmentOptionsSchema = z.object({
  locationTemplate: z.string(),
  fileNameTemplate: z.string(),
  markdownUrlFormat: z.string()
});

/**
 * VideoOptions Schema
 */
export const VideoOptionsSchema = z.object({
  floatingPromptEnabled: z.boolean(),
  promptButtonLabel: z.string().min(1),
  promptShortcut: z.string().min(1),
  controlBarAutoPause: z.boolean().optional(),
  controlBarScreenshot: z.boolean().optional(),
  commentEditorAutoPause: z.boolean().optional(),
  promptPosition: z
    .object({
      x: z.number(),
      y: z.number()
    })
    .optional(),
  screenshotAttachment: VideoScreenshotAttachmentOptionsSchema
});

/**
 * FragmentClipperOptions Schema
 */
export const FragmentClipperOptionsSchema = z.object({
  useFootnoteFormat: z.boolean(),
  captureContext: z.boolean(),
  contextLength: z.number().int().positive(),
  contextMode: FragmentContextModeSchema,
  selectionModifierEnabled: z.boolean(),
  selectionModifierKeys: z.array(FragmentModifierKeySchema),
  keyboardShortcutsEnabled: z.boolean()
});

/**
 * ClassifierProvider Schema
 */
export const ClassifierProviderSchema = z.enum(['openai', 'compatible', 'ollama']);

/**
 * ClassifierOptions Schema
 */
export const ClassifierOptionsSchema = z.object({
  enabled: z.boolean(),
  provider: ClassifierProviderSchema,
  endpoint: z.string().url(),
  apiKey: z.string(),
  model: z.string(),
  taxonomy: z.any()
});

export const ExperimentalAiOptionsSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  apiUrl: z.string().url(),
  apiKey: z.string()
});

export const PageSummaryOptionsSchema = z.object({
  enabled: z.boolean()
});

export const ReadingOverlaySummaryOptionsSchema = z.object({
  enabled: z.boolean()
});

export const SubtitleTranslationOptionsSchema = z.object({
  enabled: z.boolean(),
  targetLanguage: z.string().min(1)
});

export const PrivacyPreferencesOptionsSchema = z.object({
  analytics: z.boolean(),
  errorReporting: z.boolean(),
  debugMode: z.boolean()
});

export const InterfaceThemeSchema = z.enum(['dark', 'light', 'system']);

/**
 * StoredOptions Schema（用于 chrome.storage 存储）
 *
 * Unknown root keys are stripped at the schema boundary. Config transfer has its
 * own explicit portable/fullBackup policy; persisted settings must use named
 * fields instead of accidental top-level extension keys.
 */
export const StoredOptionsSchema = z
  .object({
    interfaceTheme: InterfaceThemeSchema.optional(),
    rest: RestOptionsSchema.partial().extend({ baseUrl: z.string().optional() }).optional(),
    templates: TemplateOptionsSchema.partial()
      .extend({
        fragment: z.string().optional(),
        reading: z.string().optional()
      })
      .optional(),
    domainMappings: z.record(z.string()).optional(),
    aiChat: AiChatOptionsSchema.partial().optional(),
    deepResearch: DeepResearchOptionsSchema.partial().optional(),
    fragmentClipper: FragmentClipperOptionsSchema.partial().optional(),
    readingSession: ReadingSessionOptionsSchema.partial().optional(),
    video: VideoOptionsSchema.partial()
      .extend({
        screenshotAttachment: VideoScreenshotAttachmentOptionsSchema.partial().optional()
      })
      .optional(),
    classifier: ClassifierOptionsSchema.partial().optional(),
    experimentalAi: ExperimentalAiOptionsSchema.partial().optional(),
    pageSummary: PageSummaryOptionsSchema.partial().optional(),
    readingOverlaySummary: ReadingOverlaySummaryOptionsSchema.partial().optional(),
    subtitleTranslation: SubtitleTranslationOptionsSchema.partial().optional(),
    privacyPreferences: PrivacyPreferencesOptionsSchema.partial().optional(),
    vaultRouter: VaultRouterConfigSchema.optional(),
    yamlConfig: YamlConfigOverridesSchema.nullable().optional()
  })
  .strip();

/**
 * CompleteOptions Schema（合并默认值后的完整配置）
 */
export const CompleteOptionsSchema = z.object({
  interfaceTheme: InterfaceThemeSchema.optional(),
  rest: RestOptionsSchema,
  templates: TemplateOptionsSchema,
  aiChat: AiChatOptionsSchema,
  deepResearch: DeepResearchOptionsSchema,
  fragmentClipper: FragmentClipperOptionsSchema,
  readingSession: ReadingSessionOptionsSchema,
  video: VideoOptionsSchema,
  classifier: ClassifierOptionsSchema,
  experimentalAi: ExperimentalAiOptionsSchema,
  pageSummary: PageSummaryOptionsSchema,
  readingOverlaySummary: ReadingOverlaySummaryOptionsSchema,
  subtitleTranslation: SubtitleTranslationOptionsSchema,
  privacyPreferences: PrivacyPreferencesOptionsSchema,
  domainMappings: z.record(z.string())
});

/**
 * 自动生成 TypeScript 类型（替换手写类型）
 */
export type RestOptions = z.infer<typeof RestOptionsSchema>;
export type TemplateOptions = z.infer<typeof TemplateOptionsSchema>;
export type AiChatOptions = z.infer<typeof AiChatOptionsSchema>;
export type DeepResearchOptions = z.infer<typeof DeepResearchOptionsSchema>;
export type FragmentContextMode = z.infer<typeof FragmentContextModeSchema>;
export type FragmentModifierKey = z.infer<typeof FragmentModifierKeySchema>;
export type ReadingExportMode = z.infer<typeof ReadingExportModeSchema>;
export type ReaderHighlightTheme = z.infer<typeof ReaderHighlightThemeSchema>;
export type ReadingSessionOptions = z.infer<typeof ReadingSessionOptionsSchema>;
export type VideoScreenshotAttachmentOptions = z.infer<
  typeof VideoScreenshotAttachmentOptionsSchema
>;
export type VideoOptions = z.infer<typeof VideoOptionsSchema>;
export type FragmentClipperOptions = z.infer<typeof FragmentClipperOptionsSchema>;
export type ClassifierProvider = z.infer<typeof ClassifierProviderSchema>;
export type ClassifierOptions = z.infer<typeof ClassifierOptionsSchema>;
export type ExperimentalAiOptions = z.infer<typeof ExperimentalAiOptionsSchema>;
export type PageSummaryOptions = z.infer<typeof PageSummaryOptionsSchema>;
export type ReadingOverlaySummaryOptions = z.infer<typeof ReadingOverlaySummaryOptionsSchema>;
export type SubtitleTranslationOptions = z.infer<typeof SubtitleTranslationOptionsSchema>;
export type PrivacyPreferencesOptions = z.infer<typeof PrivacyPreferencesOptionsSchema>;
export type InterfaceTheme = z.infer<typeof InterfaceThemeSchema>;
export type StoredOptions = z.infer<typeof StoredOptionsSchema>;
export type CompleteOptions = z.infer<typeof CompleteOptionsSchema>;

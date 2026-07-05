import type {
  CompleteOptions,
  StoredOptions,
  OptionsState,
  ClassifierOptions,
  FragmentClipperOptions,
  ReadingSessionOptions,
  DeepResearchOptions,
  AiChatOptions,
  ReaderHighlightTheme,
  RestOptions,
  ExperimentalAiOptions,
  PageSummaryOptions,
  ReadingOverlaySummaryOptions,
  PrivacyPreferencesOptions,
  SubtitleTranslationOptions
} from '../types';
import { DEFAULT_OPTIONS } from './defaultOptions';
import { sanitizeVaultRouterConfig } from './optionsSanitizer';
import { resolveTaxonomy } from './taxonomyMigration';
import { mergeVideoOptions } from './videoOptionsMerger';

function mergeClassifierOptions(
  source?: StoredOptions['classifier']
): ClassifierOptions | undefined {
  const defaults = DEFAULT_OPTIONS.classifier;
  if (!defaults && !source) {
    return undefined;
  }

  const base = source ?? {};
  return {
    enabled: base.enabled ?? defaults?.enabled ?? false,
    provider: base.provider || defaults?.provider || 'ollama',
    endpoint: base.endpoint || defaults?.endpoint || 'http://localhost:11434/api/chat',
    apiKey: base.apiKey || defaults?.apiKey || '',
    model: base.model || defaults?.model || 'llama3.1',
    taxonomy: resolveTaxonomy(base.taxonomy ?? defaults?.taxonomy)
  };
}

const READER_HIGHLIGHT_THEMES: ReadonlyArray<ReaderHighlightTheme> = [
  'gradient',
  'purple',
  'neonYellow',
  'neonGreen',
  'neonOrange'
];

function resolveReaderHighlightTheme(
  theme: unknown,
  fallback: ReaderHighlightTheme
): ReaderHighlightTheme {
  return READER_HIGHLIGHT_THEMES.includes(theme as ReaderHighlightTheme)
    ? (theme as ReaderHighlightTheme)
    : fallback;
}

function mergeFragmentClipperOptions(
  source?: StoredOptions['fragmentClipper']
): FragmentClipperOptions | undefined {
  const defaults = DEFAULT_OPTIONS.fragmentClipper;
  if (!defaults && !source) {
    return undefined;
  }

  const base = source ?? {};
  const rawKeys = Array.isArray(base.selectionModifierKeys)
    ? base.selectionModifierKeys
    : (defaults?.selectionModifierKeys ?? []);
  const normalizedModifierKeys = rawKeys.filter(
    (key): key is FragmentClipperOptions['selectionModifierKeys'][number] => {
      return key === 'alt' || key === 'meta' || key === 'ctrl' || key === 'shift';
    }
  );
  const selectionModifierKeys =
    normalizedModifierKeys.length > 0
      ? [normalizedModifierKeys[0]]
      : [...(defaults?.selectionModifierKeys ?? ['shift'])];

  return {
    useFootnoteFormat: base.useFootnoteFormat ?? defaults?.useFootnoteFormat ?? true,
    captureContext: base.captureContext ?? defaults?.captureContext ?? false,
    contextLength: base.contextLength ?? defaults?.contextLength ?? 200,
    contextMode: base.contextMode ?? defaults?.contextMode ?? 'chars',
    selectionModifierEnabled:
      base.selectionModifierEnabled ?? defaults?.selectionModifierEnabled ?? false,
    selectionModifierKeys,
    keyboardShortcutsEnabled:
      base.keyboardShortcutsEnabled ?? defaults?.keyboardShortcutsEnabled ?? true
  };
}

function mergeReadingSessionOptions(
  source?: StoredOptions['readingSession']
): ReadingSessionOptions | undefined {
  const defaults = DEFAULT_OPTIONS.readingSession;
  if (!defaults && !source) {
    return undefined;
  }

  const base = source ?? {};
  return {
    exportMode: base.exportMode ?? defaults?.exportMode ?? 'highlights',
    highlightTheme: resolveReaderHighlightTheme(
      base.highlightTheme ?? defaults?.highlightTheme,
      defaults?.highlightTheme ?? 'gradient'
    )
  };
}

function mergeDeepResearchOptions(
  source?: StoredOptions['deepResearch']
): DeepResearchOptions | undefined {
  const defaults = DEFAULT_OPTIONS.deepResearch;
  if (!defaults && !source) {
    return undefined;
  }

  const base = source ?? {};
  return {
    pureMode: base.pureMode ?? defaults?.pureMode ?? false
  };
}

function mergeAiChatOptions(source?: StoredOptions['aiChat']): AiChatOptions | undefined {
  const defaults = DEFAULT_OPTIONS.aiChat;
  if (!defaults && !source) {
    return undefined;
  }

  const base = source ?? {};
  return {
    includeTimestamps: base.includeTimestamps ?? defaults?.includeTimestamps ?? false,
    userName: base.userName || defaults?.userName || 'USER'
  };
}

function mergeExperimentalAiOptions(
  source?: StoredOptions['experimentalAi']
): ExperimentalAiOptions | undefined {
  const defaults = DEFAULT_OPTIONS.experimentalAi;
  if (!defaults && !source) {
    return undefined;
  }

  const base = source ?? {};
  return {
    provider:
      (base.provider ?? defaults?.provider ?? '').trim() || defaults?.provider || 'compatible',
    model: (base.model ?? defaults?.model ?? '').trim() || defaults?.model || 'gpt-4.1-mini',
    apiUrl:
      (base.apiUrl ?? defaults?.apiUrl ?? '').trim() ||
      defaults?.apiUrl ||
      'https://api.openai.com/v1/chat/completions',
    apiKey: (base.apiKey ?? defaults?.apiKey ?? '').trim() || defaults?.apiKey || ''
  };
}

function mergePageSummaryOptions(
  source?: StoredOptions['pageSummary']
): PageSummaryOptions | undefined {
  const defaults = DEFAULT_OPTIONS.pageSummary;
  if (!defaults && !source) {
    return undefined;
  }

  const base = source ?? {};
  return {
    enabled: base.enabled ?? defaults?.enabled ?? false
  };
}

function mergeReadingOverlaySummaryOptions(
  source?: StoredOptions['readingOverlaySummary']
): ReadingOverlaySummaryOptions | undefined {
  const defaults = DEFAULT_OPTIONS.readingOverlaySummary;
  if (!defaults && !source) {
    return undefined;
  }

  const base = source ?? {};
  return {
    enabled: base.enabled ?? defaults?.enabled ?? false
  };
}

function mergeSubtitleTranslationOptions(
  source?: StoredOptions['subtitleTranslation']
): SubtitleTranslationOptions | undefined {
  const defaults = DEFAULT_OPTIONS.subtitleTranslation;
  if (!defaults && !source) {
    return undefined;
  }

  const base = source ?? {};
  return {
    enabled: base.enabled ?? defaults?.enabled ?? false,
    targetLanguage:
      (base.targetLanguage ?? defaults?.targetLanguage ?? '').trim() ||
      defaults?.targetLanguage ||
      'zh-CN'
  };
}

function mergePrivacyPreferencesOptions(
  source?: StoredOptions['privacyPreferences']
): PrivacyPreferencesOptions | undefined {
  const defaults = DEFAULT_OPTIONS.privacyPreferences;
  if (!defaults && !source) {
    return undefined;
  }

  const base = source ?? {};
  const analytics = base.analytics ?? defaults?.analytics ?? false;
  const errorReporting = base.errorReporting ?? defaults?.errorReporting ?? false;
  return {
    analytics,
    errorReporting,
    debugMode:
      analytics && errorReporting ? (base.debugMode ?? defaults?.debugMode ?? false) : false
  };
}

function sanitizeVaultRouter(source: StoredOptions['vaultRouter']): StoredOptions['vaultRouter'] {
  return sanitizeVaultRouterConfig(source);
}

export function mergeOptions(stored?: StoredOptions | null): OptionsState {
  const source = stored ?? {};
  const defaults = DEFAULT_OPTIONS;

  const rest: RestOptions = {
    baseUrl: source.rest?.baseUrl || defaults.rest.baseUrl,
    vault: source.rest?.vault || defaults.rest.vault,
    apiKey: source.rest?.apiKey || defaults.rest.apiKey
  };

  const sourceHttpsUrl = source.rest?.httpsUrl;
  const defaultHttpsUrl = defaults.rest.httpsUrl;
  if (sourceHttpsUrl !== undefined || defaultHttpsUrl !== undefined) {
    const resolvedHttpsUrl = sourceHttpsUrl || defaultHttpsUrl;
    if (resolvedHttpsUrl !== undefined) {
      rest.httpsUrl = resolvedHttpsUrl;
    }
  }

  const sourceHttpUrl = source.rest?.httpUrl;
  const defaultHttpUrl = defaults.rest.httpUrl;
  if (sourceHttpUrl !== undefined || defaultHttpUrl !== undefined) {
    const resolvedHttpUrl = sourceHttpUrl || defaultHttpUrl;
    if (resolvedHttpUrl !== undefined) {
      rest.httpUrl = resolvedHttpUrl;
    }
  }

  const sourceLocalFolderId = source.rest?.localFolderId;
  if (sourceLocalFolderId !== undefined) {
    rest.localFolderId = sourceLocalFolderId;
  }

  const sourceLocalFolderName = source.rest?.localFolderName;
  if (sourceLocalFolderName !== undefined) {
    rest.localFolderName = sourceLocalFolderName;
  }

  const storedTemplates = source.templates ?? {};
  const legacyClipper =
    typeof storedTemplates === 'object'
      ? (storedTemplates as Record<string, unknown>).clipper
      : undefined;
  const legacyClipperString = typeof legacyClipper === 'string' ? legacyClipper : undefined;

  const templates = {
    article: source.templates?.article || defaults.templates.article,
    video: source.templates?.video || defaults.templates.video,
    fragment: source.templates?.fragment || legacyClipperString || defaults.templates.fragment,
    reading:
      source.templates?.reading ||
      source.templates?.fragment ||
      legacyClipperString ||
      defaults.templates.reading,
    ai: source.templates?.ai || defaults.templates.ai
  };

  const domainMappings = source.domainMappings
    ? { ...source.domainMappings }
    : { ...defaults.domainMappings };

  const options: OptionsState = {
    interfaceTheme:
      source.interfaceTheme === 'light' ||
      source.interfaceTheme === 'dark' ||
      source.interfaceTheme === 'system'
        ? source.interfaceTheme
        : (defaults.interfaceTheme ?? 'system'),
    rest,
    templates,
    domainMappings
  };

  const knownKeys = new Set([
    'rest',
    'interfaceTheme',
    'templates',
    'domainMappings',
    'aiChat',
    'deepResearch',
    'fragmentClipper',
    'readingSession',
    'video',
    'classifier',
    'experimentalAi',
    'pageSummary',
    'readingOverlaySummary',
    'subtitleTranslation',
    'privacyPreferences',
    'vaultRouter',
    'yamlConfig'
  ]);

  const classifier = mergeClassifierOptions(source.classifier);
  if (classifier !== undefined) {
    options.classifier = classifier;
  }

  const deepResearch = mergeDeepResearchOptions(source.deepResearch);
  if (deepResearch !== undefined) {
    options.deepResearch = deepResearch;
  }

  const fragmentClipper = mergeFragmentClipperOptions(source.fragmentClipper);
  if (fragmentClipper !== undefined) {
    options.fragmentClipper = fragmentClipper;
  }

  const readingSession = mergeReadingSessionOptions(source.readingSession);
  if (readingSession !== undefined) {
    options.readingSession = readingSession;
  }

  const aiChat = mergeAiChatOptions(source.aiChat);
  if (aiChat !== undefined) {
    options.aiChat = aiChat;
  }

  const video = mergeVideoOptions(source.video);
  if (video !== undefined) {
    options.video = video;
  }

  const experimentalAi = mergeExperimentalAiOptions(source.experimentalAi);
  if (experimentalAi !== undefined) {
    options.experimentalAi = experimentalAi;
  }

  const pageSummary = mergePageSummaryOptions(source.pageSummary);
  if (pageSummary !== undefined) {
    options.pageSummary = pageSummary;
  }

  const readingOverlaySummary = mergeReadingOverlaySummaryOptions(source.readingOverlaySummary);
  if (readingOverlaySummary !== undefined) {
    options.readingOverlaySummary = readingOverlaySummary;
  }

  const subtitleTranslation = mergeSubtitleTranslationOptions(source.subtitleTranslation);
  if (subtitleTranslation !== undefined) {
    options.subtitleTranslation = subtitleTranslation;
  }

  const privacyPreferences = mergePrivacyPreferencesOptions(source.privacyPreferences);
  if (privacyPreferences !== undefined) {
    options.privacyPreferences = privacyPreferences;
  }

  const vaultRouter = sanitizeVaultRouter(source.vaultRouter);
  if (vaultRouter !== undefined) {
    options.vaultRouter = vaultRouter;
  }

  if (source.yamlConfig !== undefined) {
    options.yamlConfig = source.yamlConfig;
  }

  for (const [key, value] of Object.entries(source as unknown as Record<string, unknown>)) {
    if (!knownKeys.has(key)) {
      (options as unknown as Record<string, unknown>)[key] = value;
    }
  }

  return options;
}

export function omitLegacyRestRootDir<TRest extends object | undefined>(rest: TRest): TRest {
  if (!rest || !('rootDir' in rest)) {
    return rest;
  }

  const restWithoutRootDir = { ...(rest as Record<string, unknown>) };
  delete restWithoutRootDir.rootDir;
  return restWithoutRootDir as TRest;
}

export function omitLegacyRestRootDirFromOptions<TOptions extends StoredOptions | CompleteOptions>(
  options: TOptions
): TOptions {
  if (!options.rest || !('rootDir' in options.rest)) {
    return options;
  }

  return {
    ...options,
    rest: omitLegacyRestRootDir(options.rest)
  } as TOptions;
}

export const optionsMerger = {
  merge: (stored?: StoredOptions | null) => mergeOptions(stored ?? null)
};

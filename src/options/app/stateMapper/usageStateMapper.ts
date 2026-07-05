import { normalizeUsageStats } from '@shared/constants';
import { prepareUsageHistory } from '@options/stitch/usageHistory';
import type { CompleteOptions } from '@shared/types/options';
import type { UsageStats } from '@shared/types/usage';
import type { PreviewContent } from '@options/stitch/types';
import { DEFAULT_PRODUCTION_ENGLISH_MESSAGES } from '@options/stitch/schema/i18n';
import { resolveExtensionVersionLabel } from '../productionStitchVersion';
import { toTemplateValues } from './yamlStateMapper';
import { toRoutingRules, toVaultRecord } from './vaultStateMapper';

export const LEGACY_USAGE_STATS_STORAGE_KEY = 'usage_stats';

function resolveUsageStatsFromOptions(options: CompleteOptions): UsageStats {
  return normalizeUsageStats((options as CompleteOptions & { usageStats?: unknown }).usageStats);
}

function usageHistoryLabel(date: string): string {
  const parts = date.split('-');
  if (parts.length === 3) {
    return `${parts[1]}-${parts[2]}`;
  }
  return date;
}

function usageStatsToOverview(
  overview: PreviewContent['overview'],
  usageStats: UsageStats
): PreviewContent['overview'] {
  const total = usageStats.aiChatSaves + usageStats.fragmentSaves + usageStats.articleSaves;
  return {
    ...overview,
    stats: [
      { label: DEFAULT_PRODUCTION_ENGLISH_MESSAGES.usageTotalLabel, value: total },
      {
        label: DEFAULT_PRODUCTION_ENGLISH_MESSAGES.usageAiLabel,
        value: usageStats.aiChatSaves
      },
      {
        label: DEFAULT_PRODUCTION_ENGLISH_MESSAGES.usageFragmentLabel,
        value: usageStats.fragmentSaves
      },
      {
        label: DEFAULT_PRODUCTION_ENGLISH_MESSAGES.usageArticleLabel,
        value: usageStats.articleSaves
      }
    ],
    history: prepareUsageHistory(usageStats).map((entry) => ({
      label: usageHistoryLabel(entry.date),
      value: entry.aiChat + entry.fragment + entry.article
    }))
  };
}

export function createProductionContent(
  base: PreviewContent,
  options: CompleteOptions,
  overrides: {
    connectionNotice?: PreviewContent['storage']['connectionNotice'];
    maintenanceLog?: string;
  } = {}
): PreviewContent {
  const usageStats = resolveUsageStatsFromOptions(options);
  return {
    ...base,
    brand: {
      ...base.brand,
      title: 'Zendio',
      subtitle: resolveExtensionVersionLabel()
    },
    surfaceLinks: [],
    overview: usageStatsToOverview(base.overview, usageStats),
    storage: {
      ...base.storage,
      vaults: toVaultRecord(options),
      routingRules: toRoutingRules(options),
      ...(overrides.connectionNotice ? { connectionNotice: overrides.connectionNotice } : {})
    },
    output: {
      ...base.output,
      templateDefaults: toTemplateValues(options),
      domainMappings: Object.entries(options.domainMappings).map(([domain, alias]) => [
        domain,
        alias,
        'Production mapping'
      ])
    },
    experimental: {
      ...base.experimental,
      aiDefaults: { ...options.experimentalAi }
    },
    maintenanceLog: overrides.maintenanceLog ?? base.maintenanceLog
  };
}

import { readExactOwnDataRecord } from '../../shared/guards/exactOwnDataRecord';
import type { RuntimePropertyValue } from '../../shared/guards/object';

export const RESTORE_DATA_POLICY_PRUNE_FAILED = 'RESTORE_DATA_POLICY_PRUNE_FAILED';

export interface RestoreDataPolicyPruneMessageResult {
  expiredDrafts: number;
  excessDrafts: number;
  newlyOrphanedScreenshots: number;
}

export function normalizeRestoreDataPolicyPruneResult(
  value: RuntimePropertyValue
): RestoreDataPolicyPruneMessageResult | null {
  const result = readExactOwnDataRecord(value, [
    'expiredDrafts',
    'excessDrafts',
    'newlyOrphanedScreenshots'
  ]);
  return result !== null &&
    isNonNegativeInteger(result.expiredDrafts) &&
    isNonNegativeInteger(result.excessDrafts) &&
    isNonNegativeInteger(result.newlyOrphanedScreenshots)
    ? {
        expiredDrafts: result.expiredDrafts,
        excessDrafts: result.excessDrafts,
        newlyOrphanedScreenshots: result.newlyOrphanedScreenshots
      }
    : null;
}

function isNonNegativeInteger(value: RuntimePropertyValue): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

import { describe, expect, it } from 'vitest';
import { normalizeRestoreStorageMaintenanceResponse } from '@content/sessionDrafts/restoreStorageMaintenanceMessages';

function pressureResult() {
  return {
    triggered: true,
    reason: 'pressure-detected',
    initialEstimate: { usage: 90, quota: 100, available: 10, supported: true },
    finalEstimate: { usage: 70, quota: 100, available: 30, supported: true },
    removed: {
      expiredScreenshots: 1,
      orphanScreenshots: 2,
      expiredDrafts: 3,
      excessDrafts: 4,
      newlyOrphanedScreenshots: 5
    }
  };
}

describe('restore storage maintenance response codec', () => {
  it('returns detached clear and pressure result snapshots', () => {
    const clear = {
      draftKeysRemoved: 1,
      screenshotEntriesRemoved: 2,
      legacyScreenshotKeysRemoved: 3
    };
    const pressure = pressureResult();
    const normalizedClear = normalizeRestoreStorageMaintenanceResponse(
      { success: true, operation: 'clearAllRestoreData', result: clear },
      'clearAllRestoreData'
    );
    const normalizedPressure = normalizeRestoreStorageMaintenanceResponse(
      { success: true, operation: 'inspectStoragePressure', result: pressure },
      'inspectStoragePressure'
    );

    clear.draftKeysRemoved = 99;
    pressure.initialEstimate.usage = 99;
    pressure.removed.expiredDrafts = 99;

    expect(normalizedClear?.result).toEqual({
      draftKeysRemoved: 1,
      screenshotEntriesRemoved: 2,
      legacyScreenshotKeysRemoved: 3
    });
    expect(normalizedPressure?.result).toEqual(pressureResult());
  });

  it('rejects accessor-backed nested pressure records without reading them', () => {
    let reads = 0;
    const estimate = pressureResult().initialEstimate;
    Reflect.defineProperty(estimate, 'usage', {
      enumerable: true,
      get() {
        reads += 1;
        return 90;
      }
    });

    expect(
      normalizeRestoreStorageMaintenanceResponse(
        {
          success: true,
          operation: 'runStoragePressureCleanup',
          result: { ...pressureResult(), initialEstimate: estimate }
        },
        'runStoragePressureCleanup'
      )
    ).toBeNull();
    expect(reads).toBe(0);
  });
});

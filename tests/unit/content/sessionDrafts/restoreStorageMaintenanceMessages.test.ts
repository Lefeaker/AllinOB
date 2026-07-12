import { describe, expect, it } from 'vitest';
import {
  isRestoreStorageMaintenanceMessage,
  normalizeRestoreStorageMaintenanceResponse
} from '@content/sessionDrafts/restoreStorageMaintenanceMessages';

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

function policyPruneResult() {
  return {
    expiredDrafts: 2,
    excessDrafts: 3,
    newlyOrphanedScreenshots: 4
  };
}

describe('restore storage maintenance response codec', () => {
  it('accepts only an exact bounded policy-prune operation message', () => {
    const message = {
      type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
      operation: 'pruneRestoreDataToCurrentPolicy',
      operationId: 'policy-prune-1'
    };

    expect(isRestoreStorageMaintenanceMessage(message)).toBe(true);
    expect(isRestoreStorageMaintenanceMessage({ ...message, extra: true })).toBe(false);
    expect(isRestoreStorageMaintenanceMessage({ ...message, operationId: '' })).toBe(false);
    for (const operationId of [
      globalThis.crypto.randomUUID(),
      'clear-client_1:retry.2',
      'x'.repeat(128)
    ]) {
      expect(isRestoreStorageMaintenanceMessage({ ...message, operationId })).toBe(true);
    }
    for (const operationId of [
      'x'.repeat(129),
      ' leading',
      'embedded space',
      'line\nbreak',
      'tab\tvalue',
      'control\u0000value',
      '操作',
      'emoji-😀',
      'surrogate-\ud800'
    ]) {
      expect(isRestoreStorageMaintenanceMessage({ ...message, operationId })).toBe(false);
    }
    expect(
      isRestoreStorageMaintenanceMessage({
        type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
        operation: 'clearAllRestoreData',
        operationId: 'legacy clear id 操作'
      })
    ).toBe(true);
  });

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

  it('normalizes only an exact non-negative policy-prune result', () => {
    const result = policyPruneResult();
    const normalized = normalizeRestoreStorageMaintenanceResponse(
      { success: true, operation: 'pruneRestoreDataToCurrentPolicy', result },
      'pruneRestoreDataToCurrentPolicy'
    );

    result.expiredDrafts = 99;
    expect(normalized).toEqual({
      success: true,
      operation: 'pruneRestoreDataToCurrentPolicy',
      result: policyPruneResult()
    });
    expect(
      normalizeRestoreStorageMaintenanceResponse(
        {
          success: true,
          operation: 'pruneRestoreDataToCurrentPolicy',
          result: { ...policyPruneResult(), extra: 1 }
        },
        'pruneRestoreDataToCurrentPolicy'
      )
    ).toBeNull();
    expect(
      normalizeRestoreStorageMaintenanceResponse(
        {
          success: true,
          operation: 'pruneRestoreDataToCurrentPolicy',
          result: { ...policyPruneResult(), excessDrafts: -1 }
        },
        'pruneRestoreDataToCurrentPolicy'
      )
    ).toBeNull();
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

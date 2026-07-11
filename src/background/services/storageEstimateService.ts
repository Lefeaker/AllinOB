import type { StorageEstimateMessageSnapshot } from '../../content/sessionDrafts/restoreStorageMaintenanceMessages';
import type { RuntimePropertyValue } from '../../shared/guards/object';

export interface StorageEstimateSnapshot extends StorageEstimateMessageSnapshot {}

interface RawStorageEstimate {
  usage?: number;
  quota?: number;
}

export interface StorageEstimateServiceOptions {
  estimate?: (() => Promise<RawStorageEstimate>) | null;
}

export interface StorageEstimateService {
  getSnapshot(): Promise<StorageEstimateSnapshot>;
}

export function createStorageEstimateService(
  options: StorageEstimateServiceOptions = {}
): StorageEstimateService {
  const estimate = options.estimate === undefined ? resolveBrowserEstimate() : options.estimate;
  return {
    async getSnapshot() {
      if (!estimate) {
        return createUnavailableSnapshot(false);
      }
      try {
        const value = await estimate();
        if (!isValidUsage(value.usage) || !isValidQuota(value.quota)) {
          return createUnavailableSnapshot(true);
        }
        return {
          usage: value.usage,
          quota: value.quota,
          available: Math.max(0, value.quota - value.usage),
          supported: true
        };
      } catch {
        return createUnavailableSnapshot(true);
      }
    }
  };
}

function resolveBrowserEstimate(): (() => Promise<RawStorageEstimate>) | null {
  const storage = globalThis.navigator?.storage;
  return typeof storage?.estimate === 'function' ? () => storage.estimate() : null;
}

function createUnavailableSnapshot(supported: boolean): StorageEstimateSnapshot {
  return { usage: null, quota: null, available: null, supported };
}

function isValidUsage(value: RuntimePropertyValue): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isValidQuota(value: RuntimePropertyValue): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

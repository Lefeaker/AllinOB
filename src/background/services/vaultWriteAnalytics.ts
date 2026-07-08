import { trackUsageEvent } from './analyticsEvents';
import type { DurationBucket, StorageTarget } from '../../shared/types/analytics';

interface VaultWriteAnalyticsTarget {
  storageTarget: 'local-folder' | 'rest-api';
}

export function trackLocalVaultPermissionPrompted(): void {
  void trackUsageEvent('local_vault_permission_prompted', {
    source: 'clip'
  });
}

export function trackLocalVaultPermissionResolved(
  outcome: 'completed' | 'failed' | 'cancelled'
): void {
  void trackUsageEvent('local_vault_permission_resolved', { outcome });
}

export function trackVaultWriteCompleted(
  target: VaultWriteAnalyticsTarget,
  startedAt: number
): void {
  void trackUsageEvent('vault_write_completed', {
    storage_target: toAnalyticsStorageTarget(target),
    duration_bucket: toDurationBucket(Date.now() - startedAt)
  });
}

export function trackVaultWriteFailed(
  target: VaultWriteAnalyticsTarget,
  failureCategory: 'connection' | 'write'
): void {
  void trackUsageEvent('vault_write_failed', {
    storage_target: toAnalyticsStorageTarget(target),
    failure_category: failureCategory
  });
}

function toAnalyticsStorageTarget(target: VaultWriteAnalyticsTarget): StorageTarget {
  return target.storageTarget === 'local-folder' ? 'local_folder' : 'rest_api';
}

function toDurationBucket(durationMs: number): DurationBucket {
  if (durationMs < 100) return 'under_100ms';
  if (durationMs < 500) return '100ms_to_499ms';
  if (durationMs < 1000) return '500ms_to_999ms';
  if (durationMs < 3000) return '1s_to_2s';
  if (durationMs < 10000) return '3s_to_9s';
  if (durationMs < 30000) return '10s_to_29s';
  if (durationMs < 120000) return '30s_to_119s';
  return '2m_plus';
}

import type { RuntimePropertyValue } from '../../shared/guards/object';

export const RESTORE_DATA_POLICY_PRUNE_OPERATION_ID_MAX_LENGTH = 128;

const RESTORE_DATA_POLICY_PRUNE_OPERATION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;

export function isRestoreDataPolicyPruneOperationId(value: RuntimePropertyValue): value is string {
  return (
    typeof value === 'string' &&
    value.length <= RESTORE_DATA_POLICY_PRUNE_OPERATION_ID_MAX_LENGTH &&
    RESTORE_DATA_POLICY_PRUNE_OPERATION_ID_PATTERN.test(value)
  );
}

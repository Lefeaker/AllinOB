import { isObjectRecord, type RuntimePropertyValue } from '../../shared/guards/object';
import { canonicalJsonStringify } from '../../shared/serialization/canonicalJson';

export const SESSION_DRAFT_DELETE_RECORD_MAX_BYTES = 16 * 1024;
const encoder = new TextEncoder();

export function assertSessionDraftDeletionRecordBounded(value: RuntimePropertyValue): void {
  if (!isSessionDraftDeletionRecordBounded(value)) {
    throw new Error('RESTORE_STORAGE_DELETE_RECORD_TOO_LARGE');
  }
}

export function isSessionDraftDeletionRecordBounded(value: RuntimePropertyValue): boolean {
  return (
    isObjectRecord(value) &&
    encoder.encode(canonicalJsonStringify(value)).byteLength <=
      SESSION_DRAFT_DELETE_RECORD_MAX_BYTES
  );
}

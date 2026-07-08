import {
  DEFAULT_SESSION_DRAFT_STORAGE_POLICY,
  createSessionDraftStoragePolicy,
  type SessionDraftStoragePolicy,
  type SessionDraftStoragePolicyOptions
} from '../../content/sessionDrafts';

export type RestoreCapabilityPolicy = SessionDraftStoragePolicy;
export type RestoreCapabilityPolicyOptions = SessionDraftStoragePolicyOptions;

export const DEFAULT_RESTORE_CAPABILITY_POLICY: RestoreCapabilityPolicy =
  DEFAULT_SESSION_DRAFT_STORAGE_POLICY;

export function createExtendedRestoreCapabilityPolicy(
  options: RestoreCapabilityPolicyOptions = {}
): RestoreCapabilityPolicy {
  return createSessionDraftStoragePolicy(options);
}

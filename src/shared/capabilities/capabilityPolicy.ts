import {
  DEFAULT_SESSION_DRAFT_STORAGE_POLICY,
  createSessionDraftStoragePolicy,
  type SessionDraftStoragePolicy,
  type SessionDraftStoragePolicyOptions
} from '../../content/sessionDrafts';

export type RestoreCapabilityPolicy = SessionDraftStoragePolicy;
export type RestoreCapabilityPolicyOptions = SessionDraftStoragePolicyOptions;
export type RestoreCapabilityPolicyChangeListener = (policy: RestoreCapabilityPolicy) => void;
export type RestoreCapabilityPolicyUnsubscribe = () => void;

export interface RestoreCapabilityPolicyProvider {
  getCurrentPolicy(): RestoreCapabilityPolicy;
  refreshPolicy?(): Promise<RestoreCapabilityPolicy> | RestoreCapabilityPolicy;
  subscribePolicyChanges?(
    listener: RestoreCapabilityPolicyChangeListener
  ): RestoreCapabilityPolicyUnsubscribe;
}

export const DEFAULT_RESTORE_CAPABILITY_POLICY: RestoreCapabilityPolicy =
  DEFAULT_SESSION_DRAFT_STORAGE_POLICY;

export const defaultRestoreCapabilityPolicyProvider: RestoreCapabilityPolicyProvider = {
  getCurrentPolicy: () => DEFAULT_RESTORE_CAPABILITY_POLICY,
  refreshPolicy: () => Promise.resolve(DEFAULT_RESTORE_CAPABILITY_POLICY)
};

export function createExtendedRestoreCapabilityPolicy(
  options: RestoreCapabilityPolicyOptions = {}
): RestoreCapabilityPolicy {
  return createSessionDraftStoragePolicy(options);
}

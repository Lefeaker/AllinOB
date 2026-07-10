import type { SessionDraftStoragePolicy } from '../sessionDrafts';
import type { SupportProgressReporter } from './supportProgress';

interface LazySessionPolicyDependencies {
  sessionDraftStoragePolicy?: SessionDraftStoragePolicy;
  getSessionDraftStoragePolicy?: () => SessionDraftStoragePolicy;
  showSupportProgress?: SupportProgressReporter;
}

export function selectLazySessionPolicyDependencies(dependencies: LazySessionPolicyDependencies) {
  return {
    ...(dependencies.sessionDraftStoragePolicy
      ? { sessionDraftStoragePolicy: dependencies.sessionDraftStoragePolicy }
      : {}),
    ...(dependencies.getSessionDraftStoragePolicy
      ? { getSessionDraftStoragePolicy: dependencies.getSessionDraftStoragePolicy }
      : {}),
    ...(dependencies.showSupportProgress
      ? { showSupportProgress: dependencies.showSupportProgress }
      : {})
  };
}
